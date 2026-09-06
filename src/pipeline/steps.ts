/**
 * ---------------------------------------------------------------------------
 * The ingest pipeline: collect -> normalise -> resolve -> evaluate -> detect
 * ---------------------------------------------------------------------------
 * Each exported handler is one Lambda function. They are pure-ish and take
 * plain objects, which means you can unit test the whole pipeline without
 * AWS, without mocks, and without a deploy. That testability is the reason to
 * split them at all - a single "do everything" Lambda is cheaper to invoke and
 * far more expensive to own.
 *
 * THE STRUCTURAL DECISION THAT MATTERS: telemetry does not become events.
 * Only exceptions do. At full fleet scale this pipeline sees ~11,000 readings
 * per second; pushing those through a content-filtered event bus would be both
 * slow and ruinous. They go to a key-value overwrite and a batched rules pass
 * instead, and only the handful that turn into exceptions ever reach
 * EventBridge. See `publish()`.
 */
import type {
  Driver, Exception, Incident, Principal, RawRecord, Telemetry,
} from '../platform/types.ts';
import { connectorsFor, breakers, safeConcurrency } from '../integrations/registry.ts';
import { withRetry, type Connector } from '../integrations/connector.ts';
import { archiveRaw } from '../aws/s3.ts';
import { bus } from '../aws/eventbridge.ts';
import { putTelemetry, putDrivers, putExceptions, putIncident } from '../platform/repository.ts';
import { allDrivers, districtContaining, locationOf } from '../geo/driver-repository.ts';
import { haversineKm } from '../geo/spatial.ts';
import { exceptionId, incidentId } from '../platform/ids.ts';
import { nowIso } from '../platform/clock.ts';
import { log } from '../platform/logger.ts';

export type PipelineInput = { principal: Principal; since: string };

// ---------------------------------------------------------------------------
// 1. COLLECT - one invocation per connector (the Map state's iterator)
// ---------------------------------------------------------------------------

/**
 * Fetch one vendor and archive the raw payload.
 *
 * Order matters: archive to S3 BEFORE normalising. If normalise() throws, the
 * data is already durable and you can replay it once the bug is fixed. Archive
 * afterwards and a mapping bug loses the data permanently.
 *
 * The retry wrapper and the circuit breaker are both here rather than in the
 * connector so that every vendor gets identical resilience behaviour.
 */
export async function collectOne(args: {
  connector: Connector;
  input: PipelineInput;
}): Promise<{ raw: RawRecord; s3Uri: string } | { failed: string }> {
  const { connector, input } = args;
  const breaker = breakers.get(connector.provider)!;

  try {
    const raw = await breaker.run(() =>
      withRetry('fetch:' + connector.provider, () =>
        connector.fetchRaw({
          tenantId: input.principal.tenantId,
          secrets: {},                       // Secrets Manager in production
          since: new Date(input.since),
        }),
      ),
    );

    return { raw, s3Uri: archiveRaw(raw) };
  } catch (err) {
    // One dead vendor must not fail the run. Partial data beats no data on a
    // dispatch board - a missing dashcam feed is survivable, a blank map is not.
    const message = err instanceof Error ? err.message : String(err);
    log.error('collector failed, continuing', { provider: connector.provider, error: message });
    return { failed: connector.provider };
  }
}

/**
 * The full fan-out, respecting each vendor's rate limit.
 *
 * Note `connectorsFor(principal)`: a carrier runs the two or three vendors it
 * actually bought, not all eight. See integrations/registry.ts.
 */
export async function collectAll(input: PipelineInput) {
  const results = [];
  for (const connector of connectorsFor(input.principal)) {
    // safeConcurrency() would cap parallelism per vendor in a Map state; here
    // the loop is sequential-per-vendor for readable, deterministic output.
    void safeConcurrency(connector);
    results.push(await collectOne({ connector, input }));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. NORMALISE - vendor payload -> canonical Telemetry
// ---------------------------------------------------------------------------

export function normaliseAll(
  principal: Principal,
  collected: Array<{ raw: RawRecord } | { failed: string }>,
): Telemetry[] {
  const readings: Telemetry[] = [];
  const available = connectorsFor(principal);

  for (const item of collected) {
    if (!('raw' in item)) continue;

    const connector = available.find((c) => c.provider === item.raw.provider);
    if (!connector) continue;

    try {
      readings.push(...connector.normalise(item.raw));
    } catch (err) {
      // A mapping bug in ONE vendor must not lose the others. The raw payload
      // is already in S3, so this is recoverable by replay.
      log.error('normalise failed', {
        provider: item.raw.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return readings;
}

// ---------------------------------------------------------------------------
// 3. RESOLVE TERRITORY - which district does this point fall in
// ---------------------------------------------------------------------------

/**
 * Devices know coordinates; they do not know your dispatch geography.
 * Resolution is the join, and doing it once at write time means every
 * downstream read - the board, the agent, the incident - gets district for free.
 *
 * At fleet scale this is the hot path, and it is why the two-phase spatial
 * check in geo/spatial.ts exists: a PostGIS round trip per ping is neither fast
 * nor cheap, so the bounding-box pre-filter runs in memory against geofences
 * cached at module scope, and only the survivors get an exact test.
 */
export function resolveTerritory(principal: Principal, readings: Telemetry[]): Telemetry[] {
  return readings.map((t) => {
    if (!t.location) return t;                    // an ELD reports a clock, not a place
    const district = districtContaining(principal, t.location) ?? '';
    return { ...t, location: { ...t.location, district } };
  });
}

/**
 * Fold the newest reading for each driver into the hot-state item.
 *
 * OVERWRITE, never append. This is the write that keeps the operational store
 * bounded by fleet size rather than by ping rate.
 */
export function foldDriverState(principal: Principal, readings: Telemetry[]): Driver[] {
  const current = new Map(allDrivers(principal).map((d) => [d.driverId, { ...d }]));

  for (const t of readings) {
    const driver = current.get(t.driverId);
    if (!driver) continue;

    if (t.kind === 'position' && t.location) {
      driver.lon = t.location.lon;
      driver.lat = t.location.lat;
      driver.updatedAt = t.observedAt;
    }
    if (t.kind === 'hos-remaining') {
      driver.hosRemainingMinutes = t.value;
      driver.updatedAt = t.observedAt;
    }
  }
  return [...current.values()];
}

// ---------------------------------------------------------------------------
// 4. EVALUATE - deterministic rules, one driver at a time -> Exception[]
// ---------------------------------------------------------------------------

/**
 * Rules, applied per driver. Deliberately NOT an LLM: what counts as an
 * exception must be identical every time and explainable to the person it
 * paged at 4am. The model's job starts afterwards.
 *
 * An Exception here is a CANDIDATE. It is not yet a page - corroboration and
 * merging happen in detectIncidents().
 */
export function evaluate(principal: Principal, readings: Telemetry[]): Exception[] {
  const byDriver = new Map<string, Telemetry[]>();
  for (const t of readings) {
    const list = byDriver.get(t.driverId) ?? [];
    list.push(t);
    byDriver.set(t.driverId, list);
  }

  const exceptions: Exception[] = [];

  for (const [driverId, driverReadings] of byDriver) {
    const located = driverReadings.find((t) => t.location);
    const fallback = locationOf(principal, driverId);
    const location = located?.location
      ? { lon: located.location.lon, lat: located.location.lat }
      : { lon: fallback?.lon ?? 0, lat: fallback?.lat ?? 0 };
    const districtId = located?.location?.district || fallback?.district || '';

    const raise = (
      kind: Exception['kind'],
      matching: Telemetry[],
      severity: Exception['severity'],
    ) => {
      exceptions.push({
        tenantId: principal.tenantId,
        exceptionId: exceptionId(),
        driverId,
        districtId,
        kind,
        severity,
        telemetryIds: matching.map((t) => t.telemetryId),
        // The DISTINCT vendors that saw it. This is the field detectIncidents
        // corroborates on, so it has to be a set - two readings from one vendor
        // is one witness, not two.
        providers: [...new Set(matching.map((t) => t.provider))],
        location,
        raisedAt: nowIso(),
      });
    };

    const braking = driverReadings.filter((t) => t.kind === 'harsh-brake' && t.severity !== 'ok');
    if (braking.length > 0) raise('harsh-braking', braking, worst(braking));

    const idling = driverReadings.filter((t) => t.kind === 'idle' && t.severity !== 'ok');
    if (idling.length > 0) raise('prolonged-idle', idling, worst(idling));

    const hos = driverReadings.filter((t) => t.kind === 'hos-remaining' && t.severity !== 'ok');
    if (hos.length > 0) raise('hos-risk', hos, worst(hos));

    const deviation = driverReadings.filter(
      (t) => t.kind === 'route-adherence' && t.severity !== 'ok',
    );
    if (deviation.length > 0) raise('route-deviation', deviation, worst(deviation));

    const panic = driverReadings.filter((t) => t.kind === 'panic');
    if (panic.length > 0) raise('panic', panic, 'critical');
  }

  return exceptions;
}

function worst(readings: Telemetry[]): Exception['severity'] {
  const rank = { ok: 0, info: 1, warning: 2, critical: 3 } as const;
  return readings.reduce<Exception['severity']>(
    (acc, t) => (rank[t.severity] > rank[acc] ? t.severity : acc),
    'ok',
  );
}

// ---------------------------------------------------------------------------
// 5. DETECT - corroborate and merge exceptions into incidents
// ---------------------------------------------------------------------------

/** How close two exceptions must be to be the same event. */
const MERGE_RADIUS_KM = 3;
/** And how close in time. Drivers move; sites do not. */
const MERGE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Correlation, kept deliberately simple and explainable:
 *
 *   a) an exception seen by 2+ INDEPENDENT vendors is real; one seen by a
 *      single vendor is a candidate, not an incident. Agreement across
 *      independent hardware is the cheapest noise filter there is - a GPS drift
 *      spike that looks like a route deviation, corroborated by nothing, is
 *      noise. The same deviation plus a stationary vehicle is real.
 *   b) exceptions close in SPACE and TIME are one incident. A road closure
 *      affecting fourteen drivers is one page, not fourteen.
 *
 * WHY 3km AND 15 MINUTES - and why this is not the site model's 150km radius:
 * sites are cities and never move, so a wide radius merged genuinely related
 * outages. Drivers sit inside a district that is itself only ~50km across, so a
 * 150km radius would merge every exception in the district into one incident,
 * always - and the merge would stop being evidence of anything. The time window
 * is needed for the same reason: two drivers passing the same point an hour
 * apart are two events, not one.
 *
 * Panic is deliberately exempt from corroboration. Waiting for a second opinion
 * before escalating a panic button would be an indefensible design.
 */
export function detectIncidents(principal: Principal, exceptions: Exception[]): Incident[] {
  const corroborated = exceptions.filter(
    (e) => e.kind === 'panic' || e.providers.length >= 2,
  );

  const incidents: Incident[] = [];
  const claimed = new Set<string>();

  for (const seed of corroborated) {
    if (claimed.has(seed.exceptionId)) continue;

    const seedTime = Date.parse(seed.raisedAt);
    const merged = corroborated.filter((e) => {
      if (claimed.has(e.exceptionId)) return false;
      if (e.kind !== seed.kind) return false;
      if (e.districtId !== seed.districtId) return false;
      if (Math.abs(Date.parse(e.raisedAt) - seedTime) > MERGE_WINDOW_MS) return false;
      return haversineKm(seed.location, e.location) <= MERGE_RADIUS_KM;
    });

    for (const m of merged) claimed.add(m.exceptionId);

    const driverIds = [...new Set(merged.map((m) => m.driverId))];
    incidents.push({
      tenantId: principal.tenantId,
      incidentId: incidentId(),
      title: driverIds.length > 1
        ? titleFor(seed.kind) + ' affecting ' + driverIds.length + ' drivers in ' + seed.districtId
        : titleFor(seed.kind) + ' - driver ' + driverIds[0],
      severity: worstException(merged),
      status: 'open',
      districtId: seed.districtId,
      driverIds,
      exceptionIds: merged.map((m) => m.exceptionId),
      openedAt: nowIso(),
    });
  }

  return incidents;
}

function titleFor(kind: Exception['kind']): string {
  const titles: Record<Exception['kind'], string> = {
    'geofence-breach': 'Geofence breach',
    'harsh-braking': 'Harsh braking',
    'route-deviation': 'Route deviation',
    'prolonged-idle': 'Prolonged idle',
    'hos-risk': 'Hours-of-service risk',
    'panic': 'PANIC ALERT',
  };
  return titles[kind];
}

function worstException(exceptions: Exception[]): Incident['severity'] {
  const rank = { ok: 0, info: 1, warning: 2, critical: 3 } as const;
  return exceptions.reduce<Incident['severity']>(
    (acc, e) => (rank[e.severity] > rank[acc] ? e.severity : acc),
    'ok',
  );
}

/** How far apart the affected drivers are - useful context for the responder. */
export function incidentSpreadKm(principal: Principal, incident: Incident): number {
  const points = incident.driverIds
    .map((id) => locationOf(principal, id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);
  if (points.length < 2) return 0;

  let maxKm = 0;
  for (const a of points) {
    for (const b of points) maxKm = Math.max(maxKm, haversineKm(a, b));
  }
  return Number(maxKm.toFixed(1));
}

// ---------------------------------------------------------------------------
// 6. PUBLISH - persist, then announce
// ---------------------------------------------------------------------------

/**
 * Write first, publish second. If the event fires before the write lands, a
 * subscriber can query for the incident and get a 404 - a real and very
 * annoying race. (The rigorous fix is the transactional outbox pattern:
 * write the event into the same DynamoDB transaction and let a DynamoDB
 * Streams handler publish it. Worth naming if asked about exactly-once.)
 *
 * NOTHING HERE PUBLISHES TELEMETRY, and that is the load-bearing decision of
 * the whole architecture. Readings are persisted and folded into hot state;
 * only exceptions and incidents reach the bus. That is what keeps bus and
 * consumer cost proportional to *incidents* rather than to *fleet size*.
 */
export async function publish(
  principal: Principal,
  readings: Telemetry[],
  drivers: Driver[],
  exceptions: Exception[],
  incidents: Incident[],
) {
  putTelemetry(principal, readings);
  putDrivers(principal, drivers);
  putExceptions(principal, exceptions);
  for (const incident of incidents) putIncident(principal, incident);

  for (const exception of exceptions) {
    await bus.putEvents({
      source: 'meridian.evaluate',
      detailType: 'ExceptionRaised',
      // Put the fields rules will filter on at the TOP level of detail -
      // EventBridge patterns match on structure, and deeply nested fields make
      // for fragile patterns.
      detail: {
        tenantId: exception.tenantId,
        exceptionId: exception.exceptionId,
        driverId: exception.driverId,
        districtId: exception.districtId,
        kind: exception.kind,
        severity: exception.severity,
      },
    });
  }

  for (const incident of incidents) {
    await bus.putEvents({
      source: 'meridian.detect',
      detailType: 'IncidentOpened',
      detail: {
        tenantId: incident.tenantId,
        incidentId: incident.incidentId,
        severity: incident.severity,
        districtId: incident.districtId,
        driverIds: incident.driverIds,
        title: incident.title,
      },
    });
  }

  return {
    telemetry: readings.length,
    drivers: drivers.length,
    exceptions: exceptions.length,
    incidents: incidents.length,
  };
}
