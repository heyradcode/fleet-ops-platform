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
import { connectorsFor, breakers } from '../integrations/registry.ts';
import { withRetry, severityFor, type Connector } from '../integrations/connector.ts';
import { archiveRaw, appendHistory } from '../aws/s3.ts';
import { telemetryStream, type Batch, type BatchResult } from '../aws/kinesis.ts';
import { bus } from '../aws/eventbridge.ts';
import { putTelemetry, putDrivers, putExceptions, putIncident } from '../platform/repository.ts';
import { allDrivers, districtContaining, locationOf } from '../geo/driver-repository.ts';
import { haversineKm } from '../geo/spatial.ts';
import { nearestCorridor } from '../data/polylines.ts';
import { exceptionId, incidentId, telemetryId } from '../platform/ids.ts';
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
// 2b. STREAM - batch, never one invocation per record
// ---------------------------------------------------------------------------

/**
 * Put normalised readings on the stream, partitioned by driver.
 *
 * Partitioning by driverId is the decision that matters: it gives ordering
 * where ordering is meaningful (one driver's pings must not overtake each
 * other) and parallelism everywhere else. Partitioning by district instead
 * would concentrate a large district's thousands of drivers onto one shard -
 * the classic hot-partition mistake.
 */
export function enqueue(readings: Telemetry[]): void {
  telemetryStream.putRecords(
    readings.map((r) => ({ partitionKey: r.driverId, data: r })),
  );
}

/**
 * The batched consumer. ONE invocation, MANY records.
 *
 * This is the shape an event-source mapping delivers, and writing the handler
 * to take an array rather than a record is what makes the arithmetic work: at
 * 11,000 readings/sec, a batch size of 500 is ~22 invocations/sec instead of
 * 11,000.
 *
 * It reports per-record failures (ReportBatchItemFailures) rather than throwing.
 * Throwing fails the whole batch, and a batch that always fails is a shard that
 * never advances - the silent backlog that shows up as a rising iterator-age
 * metric hours later.
 */
export function processBatch(
  batch: Batch<Telemetry>,
): { result: BatchResult; readings: Telemetry[] } {
  const good: Telemetry[] = [];
  const failedIds: string[] = [];

  for (const record of batch.records) {
    const reading = record.data;
    // A record that cannot be understood is isolated, not fatal. In production
    // the parse happens here too, and this is where a malformed payload from a
    // vendor's bad deploy gets quarantined instead of stopping the fleet.
    if (!reading || typeof reading.driverId !== 'string' || !Number.isFinite(reading.value)) {
      failedIds.push(record.partitionKey + ':' + String(reading?.telemetryId));
      continue;
    }
    good.push(reading);
  }

  // The cold path. Append every reading to history regardless of whether it
  // becomes an exception - history is the analytics and safety-review asset.
  appendHistory(good);

  return { result: { failedIds }, readings: good };
}

/**
 * Enqueue, then drain the stream through the batched consumer.
 *
 * In production these are two separate systems - a producer Lambda writes to
 * Kinesis, an event-source mapping invokes a consumer Lambda - and nothing
 * calls them in sequence like this. Doing so here is what makes the whole path
 * observable in one run: how many records, how many invocations, how many
 * bisections, and what ended up in the failure destination.
 */
export async function streamAndCollect(
  readings: Telemetry[],
  options?: { batchSize?: number },
): Promise<Telemetry[]> {
  enqueue(readings);

  const collected: Telemetry[] = [];
  await telemetryStream.consume(
    (batch) => {
      const { result, readings: good } = processBatch(batch as Batch<Telemetry>);
      collected.push(...good);
      return result;
    },
    (record) => record.partitionKey + ':' + String((record.data as Telemetry)?.telemetryId),
    { batchSize: options?.batchSize ?? 500 },
  );

  return collected;
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
 * Derive route adherence: how far off the planned corridor is this driver?
 *
 * DERIVED, not reported. No vendor knows your route plan - they know where the
 * truck is. Distance from the corridor is something the platform computes, and
 * that is exactly why a route deviation can never be corroborated by "a second
 * telematics vendor": there is only one position, and only one derivation from
 * it. What corroborates a deviation is a DIFFERENT KIND of evidence - the
 * vehicle also being stationary, a missed stop - which is the rule
 * isCorroborated() implements.
 *
 * Emitted as its own reading rather than an attribute on the position, so it
 * gets its own threshold, its own severity, and its own place in the timeline.
 */
export function deriveRouteAdherence(readings: Telemetry[]): Telemetry[] {
  const derived: Telemetry[] = [];

  for (const t of readings) {
    if (t.kind !== 'position' || !t.location) continue;

    const nearest = nearestCorridor(t.location, t.location.district);
    if (!nearest) continue;

    derived.push({
      ...t,
      telemetryId: telemetryId(t.provider, t.sourceRef + ':adherence', t.observedAt),
      kind: 'route-adherence',
      value: nearest.metres,
      unit: 'metres',
      severity: severityFor('route-adherence', nearest.metres),
      attributes: {
        corridorId: nearest.corridor.corridorId,
        corridorName: nearest.corridor.name,
      },
    });
  }

  return [...readings, ...derived];
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

/**
 * Exception kinds caused by WHERE the driver is.
 *
 * These merge with each other, because one external cause produces several of
 * them at once: a closed road makes drivers leave the corridor AND sit still.
 * Raising "route deviation affecting 14" and "prolonged idle affecting 14" as
 * two separate pages for one closure is the same double-paging the merge rule
 * exists to prevent, one level up.
 *
 * Everything else - hours-of-service, panic - is about that DRIVER rather than
 * that place, and never merges with anything. A driver running out of legal
 * hours next to a pile-up has two unrelated problems, and a dispatcher needs to
 * see both.
 */
const LOCATION_CAUSED = new Set<Exception['kind']>([
  'route-deviation', 'prolonged-idle', 'geofence-breach', 'harsh-braking',
]);

/** How close two exceptions must be to be the same event. */
const MERGE_RADIUS_KM = 3;
/** And how close in time. Drivers move; sites do not. */
const MERGE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Correlation, kept deliberately simple and explainable:
 *
 *   a) an exception needs a SECOND INDEPENDENT SIGNAL before it becomes a
 *      page - either a second vendor, or a different kind of evidence for the
 *      same driver at the same moment. See isCorroborated() for why "a second
 *      vendor" alone is too narrow a rule.
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
 * Panic and hours-of-service are exempt - see NEEDS_NO_CORROBORATION.
 */
/**
 * Exception kinds that do NOT need a second opinion.
 *
 * Both come from authoritative sources rather than noisy sensors:
 *
 *   panic     a person pressed a button. Waiting for corroboration before
 *             escalating that would be indefensible.
 *   hos-risk  the hours-of-service clock is a legally mandated, tamper-evident
 *             device, and a truck carries exactly one. There is no second ELD
 *             to agree with it, and treating a compliance record as a sensor
 *             reading to be double-checked misunderstands what it is.
 *
 * Everything else is a sensor and must be corroborated.
 */
const NEEDS_NO_CORROBORATION = new Set<Exception['kind']>(['panic', 'hos-risk']);

/** How close two exceptions must be to count as evidence of the same thing. */
const CORROBORATION_WINDOW_MS = 5 * 60 * 1000;

/**
 * Is there independent evidence for this exception?
 *
 * TWO INDEPENDENT SIGNALS, and it matters that "independent" is broader than
 * "a second vendor". A truck carries one GPS unit, so a route deviation can
 * never be witnessed by two telematics vendors - demanding that would make
 * route deviations permanently undetectable. What makes a deviation real is
 * different evidence pointing the same way:
 *
 *   deviation alone                       -> GPS drift. Noise.
 *   deviation + the vehicle is stationary -> something actually happened.
 *   hard braking on the accelerometer AND on the dashcam -> two devices agree.
 *
 * So: two distinct vendors, OR a second exception of a different kind for the
 * same driver at the same time. Either one is a second witness.
 */
function isCorroborated(exception: Exception, all: Exception[]): boolean {
  if (NEEDS_NO_CORROBORATION.has(exception.kind)) return true;

  // Two independent vendors saw the same thing.
  if (exception.providers.length >= 2) return true;

  // Or a different kind of evidence for the same driver, at the same moment.
  const at = Date.parse(exception.raisedAt);
  return all.some((other) =>
    other.exceptionId !== exception.exceptionId &&
    other.driverId === exception.driverId &&
    other.kind !== exception.kind &&
    Math.abs(Date.parse(other.raisedAt) - at) <= CORROBORATION_WINDOW_MS);
}

export function detectIncidents(principal: Principal, exceptions: Exception[]): Incident[] {
  const corroborated = exceptions.filter((e) => isCorroborated(e, exceptions));

  const incidents: Incident[] = [];
  const claimed = new Set<string>();

  for (const seed of corroborated) {
    if (claimed.has(seed.exceptionId)) continue;

    const seedTime = Date.parse(seed.raisedAt);
    const mergeable = LOCATION_CAUSED.has(seed.kind);

    const merged = corroborated.filter((e) => {
      if (claimed.has(e.exceptionId)) return false;
      if (e.exceptionId === seed.exceptionId) return true;
      // A driver-specific exception is an incident of its own, always.
      if (!mergeable || !LOCATION_CAUSED.has(e.kind)) return false;
      if (e.districtId !== seed.districtId) return false;
      if (Math.abs(Date.parse(e.raisedAt) - seedTime) > MERGE_WINDOW_MS) return false;
      return haversineKm(seed.location, e.location) <= MERGE_RADIUS_KM;
    });

    for (const m of merged) claimed.add(m.exceptionId);

    const driverIds = [...new Set(merged.map((m) => m.driverId))];
    incidents.push({
      tenantId: principal.tenantId,
      incidentId: incidentId(),
      // Name the incident after the most severe kind in it, not the seed - the
      // seed is just whichever exception happened to be first in the list.
      title: driverIds.length > 1
        ? titleFor(dominantKind(merged)) + ' affecting ' + driverIds.length +
          ' drivers in ' + seed.districtId
        : titleFor(dominantKind(merged)) + ' - driver ' + driverIds[0],
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

/**
 * Which kind names a merged incident.
 *
 * Ordered by how much it tells the dispatcher. "Route deviation affecting 14
 * drivers" is actionable; "prolonged idle affecting 14 drivers" describes the
 * same closure far less usefully.
 */
const KIND_PRIORITY: Exception['kind'][] = [
  'panic', 'harsh-braking', 'route-deviation', 'geofence-breach',
  'hos-risk', 'prolonged-idle',
];

function dominantKind(exceptions: Exception[]): Exception['kind'] {
  for (const kind of KIND_PRIORITY) {
    if (exceptions.some((e) => e.kind === kind)) return kind;
  }
  return exceptions[0].kind;
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
