/**
 * ---------------------------------------------------------------------------
 * The ingest pipeline: five Lambdas, orchestrated by Step Functions
 * ---------------------------------------------------------------------------
 *   collect  -> normalise -> enrich -> detect -> publish
 *
 * Each exported handler is one Lambda function. They are pure-ish and take
 * plain objects, which means you can unit test the whole pipeline without
 * AWS, without mocks, and without a deploy. That testability is the reason to
 * split them at all - a single "do everything" Lambda is cheaper to invoke and
 * far more expensive to own.
 */
import type { Incident, Principal, RawRecord, Signal } from '../platform/types.ts';
import { connectors, breakers, safeConcurrency } from '../integrations/registry.ts';
import { withRetry, type Connector } from '../integrations/connector.ts';
import { archiveRaw } from '../aws/s3.ts';
import { bus } from '../aws/eventbridge.ts';
import { putSignals, putIncident } from '../platform/repository.ts';
import { locationOf, sitesWithinRadius } from '../geo/site-repository.ts';
import { centroid, haversineKm } from '../geo/spatial.ts';
import { incidentId } from '../platform/ids.ts';
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
    // One dead vendor must not fail the run. Partial data beats no data.
    const message = err instanceof Error ? err.message : String(err);
    log.error('collector failed, continuing', { provider: connector.provider, error: message });
    return { failed: connector.provider };
  }
}

/** The full fan-out, respecting each vendor's rate limit. */
export async function collectAll(input: PipelineInput) {
  const results = [];
  for (const connector of connectors) {
    // safeConcurrency() would cap parallelism per vendor in a Map state; here
    // the loop is sequential-per-vendor for readable, deterministic output.
    void safeConcurrency(connector);
    results.push(await collectOne({ connector, input }));
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. NORMALISE - vendor payload -> canonical Signal
// ---------------------------------------------------------------------------

export function normaliseAll(
  collected: Array<{ raw: RawRecord } | { failed: string }>,
): Signal[] {
  const signals: Signal[] = [];

  for (const item of collected) {
    if (!('raw' in item)) continue;

    const connector = connectors.find((c) => c.provider === item.raw.provider)!;
    try {
      signals.push(...connector.normalise(item.raw));
    } catch (err) {
      // A mapping bug in ONE vendor must not lose the other seven. The raw
      // payload is already in S3, so this is recoverable by replay.
      log.error('normalise failed', {
        provider: item.raw.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// 3. GEO-ENRICH - attach coordinates so signals can go on a map
// ---------------------------------------------------------------------------

/**
 * Vendors know device serials and queue names; they do not know where those
 * things are. Enrichment is the join, and doing it once at write time means
 * every downstream read (map, agent, incident) gets location for free.
 */
export function enrich(principal: Principal, signals: Signal[]): Signal[] {
  return signals.map((s) => {
    const location = locationOf(principal, s.siteId);
    return location ? { ...s, location } : s;
  });
}

// ---------------------------------------------------------------------------
// 4. DETECT - turn a pile of signals into incidents
// ---------------------------------------------------------------------------

/**
 * Correlation, kept deliberately simple and explainable:
 *
 *   a) group non-OK signals by site;
 *   b) a site with critical signals from 2+ INDEPENDENT providers is a real
 *      incident, not a flapping sensor - agreement across vendors is the
 *      cheapest noise filter there is;
 *   c) if two such sites are within 150km, merge them into ONE regional
 *      incident. Eleven pages for one carrier fault is how on-call teams learn
 *      to ignore pages.
 *
 * Deliberately NOT an LLM. Detection must be deterministic, testable and
 * explainable at 3am. The LLM's job comes next: explaining an incident that
 * the rules already decided is real.
 */
export function detectIncidents(principal: Principal, signals: Signal[]): Incident[] {
  const bySite = new Map<string, Signal[]>();
  for (const s of signals) {
    if (s.severity === 'ok' || s.severity === 'info') continue;
    const list = bySite.get(s.siteId) ?? [];
    list.push(s);
    bySite.set(s.siteId, list);
  }

  // (b) cross-provider agreement
  const candidates: Array<{ siteId: string; signals: Signal[]; severity: Incident['severity'] }> = [];
  for (const [siteId, siteSignals] of bySite) {
    const criticals = siteSignals.filter((s) => s.severity === 'critical');
    const providers = new Set(criticals.map((s) => s.provider));
    if (providers.size < 2) continue;
    candidates.push({ siteId, signals: siteSignals, severity: 'critical' });
  }

  // (c) spatial merge
  const incidents: Incident[] = [];
  const claimed = new Set<string>();

  for (const candidate of candidates) {
    if (claimed.has(candidate.siteId)) continue;

    const centre = locationOf(principal, candidate.siteId);
    const near = centre ? sitesWithinRadius(principal, centre, 150) : [];
    const merged = candidates.filter(
      (c) => c.siteId === candidate.siteId || near.some((n) => n.siteId === c.siteId),
    );
    for (const m of merged) claimed.add(m.siteId);

    const siteIds = merged.map((m) => m.siteId);
    const allSignals = merged.flatMap((m) => m.signals);
    const kinds = [...new Set(allSignals.filter((s) => s.severity === 'critical').map((s) => s.kind))];

    incidents.push({
      tenantId: principal.tenantId,
      incidentId: incidentId(),
      title: siteIds.length > 1
        ? 'Regional degradation across ' + siteIds.length + ' sites (' + kinds.join(', ') + ')'
        : 'Service degradation at ' + siteIds[0] + ' (' + kinds.join(', ') + ')',
      severity: 'critical',
      status: 'open',
      siteIds,
      signalIds: allSignals.map((s) => s.signalId),
      openedAt: new Date().toISOString(),
    });
  }

  return incidents;
}

/** How far apart the affected sites are - useful context for the responder. */
export function incidentSpreadKm(principal: Principal, incident: Incident): number {
  const points = incident.siteIds
    .map((id) => locationOf(principal, id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);
  if (points.length < 2) return 0;

  const mid = centroid(points);
  return Number(Math.max(...points.map((p) => haversineKm(mid, p))).toFixed(1));
}

// ---------------------------------------------------------------------------
// 5. PUBLISH - persist, then announce
// ---------------------------------------------------------------------------

/**
 * Write first, publish second. If the event fires before the write lands, a
 * subscriber can query for the incident and get a 404 - a real and very
 * annoying race. (The rigorous fix is the transactional outbox pattern:
 * write the event into the same DynamoDB transaction and let a DynamoDB
 * Streams handler publish it. Worth naming if asked about exactly-once.)
 */
export async function publish(principal: Principal, signals: Signal[], incidents: Incident[]) {
  putSignals(principal, signals);
  for (const incident of incidents) putIncident(principal, incident);

  await bus.putEvents({
    source: 'meridian.ingest',
    detailType: 'SignalsNormalized',
    detail: {
      tenantId: principal.tenantId,
      count: signals.length,
      providers: [...new Set(signals.map((s) => s.provider))],
    },
  });

  for (const incident of incidents) {
    await bus.putEvents({
      source: 'meridian.detect',
      detailType: 'IncidentOpened',
      // Put the fields rules will filter on at the TOP level of detail -
      // EventBridge patterns match on structure, and deeply nested fields make
      // for fragile patterns.
      detail: {
        tenantId: incident.tenantId,
        incidentId: incident.incidentId,
        severity: incident.severity,
        siteIds: incident.siteIds,
        title: incident.title,
      },
    });
  }

  return { signals: signals.length, incidents: incidents.length };
}
