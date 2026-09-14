/**
 * ---------------------------------------------------------------------------
 * The ingest pipeline: collect -> normalise -> stream -> enrich -> evaluate -> detect
 * ---------------------------------------------------------------------------
 * Each exported handler is one Lambda function. They are pure-ish and take
 * plain objects, which means you can unit test the whole pipeline without AWS,
 * without mocks, and without a deploy. That testability is the reason to split
 * them at all - a single "do everything" Lambda is cheaper to invoke and far
 * more expensive to own.
 *
 * THE STRUCTURAL DECISION THAT MATTERS: observations do not become events.
 * Only alarms and incidents do. Even on cloud feeds an estate produces far more
 * observations than decisions, and putting them through a content-filtered
 * event bus would make the bill scale with estate size rather than with
 * incidents. They go to a key-value overwrite and a batched rules pass instead,
 * and only the handful that turn into alarms ever reach EventBridge. See
 * `publish()`.
 *
 * THE SECOND DECISION: every feed is now the vendor's cloud HTTP API, in one of
 * two directions, and they are not symmetrical.
 *
 *   POLL     we call them on a schedule. Complete, ordered, late. It is the
 *            reconciling sweep, and its watermark deliberately overlaps.
 *   WEBHOOK  they call us the moment something happens. Timely, partial,
 *            unordered, and occasionally delivered twice.
 *
 * Both converge on `Observation`, and nothing downstream can tell which way a
 * record arrived except by reading `encoding` - which correlation deliberately
 * ignores. What correlation reads is `plane`, and that describes where the
 * knowledge ORIGINATED rather than how it travelled. One Meraki poll returns
 * both the switch's own reported events and the cloud's opinion of that switch;
 * they are two witnesses, and a pipeline that keyed off the transport would see
 * one.
 */
import type {
  Alarm, AlarmKind, DeviceState, Incident, Observation, ObservationPlane, Principal, Severity,
} from '../platform/types.ts';
import { isEvent, isFlow, isMetric } from '../platform/types.ts';
import type { Inventory } from '../platform/inventory.ts';
import type { Connector, Resource } from '../integrations/connector.ts';
import type { RawBatch } from '../integrations/http.ts';
import { drainPages, getWatermark, setWatermark, sinceFor } from '../integrations/http.ts';
import { connectorsFor, breakers } from '../integrations/controller/registry.ts';
import { withRetry } from '../integrations/connector.ts';

import { probeEstate } from '../integrations/probe.ts';
import { archiveRaw, appendHistory, appendFlows } from '../aws/s3.ts';
import { observationStream, type Batch, type BatchResult } from '../aws/kinesis.ts';
import { bus } from '../aws/eventbridge.ts';
import {
  putObservations, putDeviceStates, putAlarms, putIncident,
} from '../platform/repository.ts';
import {
  allDeviceStates, getInventory, locationOf, isUpstreamOf, uplinkChain,
  putDeviceStates as cacheDeviceStates,
} from '../geo/device-repository.ts';
import { alarmId, incidentId } from '../platform/ids.ts';
import { nowIso } from '../platform/clock.ts';
import { log } from '../platform/logger.ts';

export type PipelineInput = { principal: Principal; since: string };

// ---------------------------------------------------------------------------
// 1. COLLECT - the pull half, one invocation per controller (the Map iterator)
// ---------------------------------------------------------------------------

/**
 * Poll one controller and archive the raw payload.
 *
 * Order matters: archive to S3 BEFORE normalising. If normalise() throws, the
 * data is already durable and you can replay it once the bug is fixed. Archive
 * afterwards and a mapping bug loses the data permanently.
 *
 * The retry wrapper and the circuit breaker are both here rather than in the
 * connector so that every controller gets identical resilience behaviour.
 */
export type Collected = { raw: RawBatch; resource: Resource; s3Uri: string };

export async function collectOne(args: {
  connector: Connector;
  input: PipelineInput;
}): Promise<Collected[] | { failed: string }> {
  const { connector, input } = args;
  const breaker = breakers.get(connector.controller)!;
  const out: Collected[] = [];

  try {
    for (const resource of connector.resources) {
      // The watermark, not "now minus the interval". A run that is late,
      // retried, or recovering from an outage would otherwise skip exactly the
      // window it was late for - and skip it silently, because there is no gap
      // to notice in a polled feed.
      const watermark = getWatermark(input.principal.tenantId, connector.controller, resource.name);
      const ctx = {
        tenantId: input.principal.tenantId,
        secrets: {},                       // Secrets Manager in production
        since: sinceFor(watermark, new Date(input.since)),
      };

      const drained = await breaker.run(() =>
        withRetry('fetch:' + connector.controller + ':' + resource.name, () =>
          drainPages((cursor) => resource.fetchPage(ctx, cursor), resource.firstPage(ctx)),
        ),
      );

      if (drained.truncated) {
        // Loud, because the alternative is a board that is quietly missing part
        // of an estate with nothing anywhere reporting a problem.
        log.warn('pagination ceiling hit - estate may be incomplete', {
          controller: connector.controller, resource: resource.name, pages: drained.pages,
        });
      }

      const raw: RawBatch = {
        tenantId: input.principal.tenantId,
        encoding: 'rest-json',
        receivedAt: nowIso(),
        source: { collector: connector.controller + '-poller', resource: resource.name },
        records: drained.records,
      };

      out.push({ raw, resource, s3Uri: archiveRaw(raw, connector.controller) });
    }

    return out;
  } catch (err) {
    // One dead controller must not fail the run. Partial data beats no data on
    // an operations board - a missing Central feed is survivable, a blank map is
    // not - and the probe still runs regardless, which is the one plane no
    // vendor outage can take away.
    const message = err instanceof Error ? err.message : String(err);
    log.error('collector failed, continuing', { controller: connector.controller, error: message });
    return { failed: connector.controller };
  }
}

// ---------------------------------------------------------------------------
// 2. NORMALISE - vendor payloads -> canonical Observations
// ---------------------------------------------------------------------------

/**
 * The pull half: controller replies.
 *
 * A mapping bug in ONE controller must not lose the others. The raw payload is
 * already in S3, so this is recoverable by replay.
 */
export function normaliseControllers(
  principal: Principal,
  inventory: Inventory,
  collected: Array<Collected[] | { failed: string }>,
): Observation[] {
  const out: Observation[] = [];
  const available = connectorsFor(principal);

  for (const item of collected) {
    if (!Array.isArray(item)) continue;

    for (const { raw, resource } of item) {
      // Which connector produced this batch is recorded on the object key
      // rather than in the payload, so it is matched back by collector name.
      const connector = available.find((c) => raw.source.collector.startsWith(c.controller));
      if (!connector) continue;

      try {
        // Stamp the provenance HERE rather than in each connector's builder
        // calls. The pipeline already knows which resource produced which
        // batch, and threading it through three connectors would be three
        // chances to forget - at which point the watermark for that resource
        // silently never advances and the poll re-reads the same window
        // forever.
        for (const o of connector.normalise(raw, inventory, resource)) {
          out.push({
            ...o,
            attributes: {
              ...o.attributes,
              controller: connector.controller,
              resource: resource.name,
            },
          });
        }
      } catch (err) {
        log.error('controller normalise failed', {
          controller: connector.controller,
          resource: resource.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return out;
}

/**
 * The push half: an alert a cloud POSTed at us.
 *
 * This is what API Gateway invokes. The delivery has ALREADY been signature-
 * verified and unwrapped by `integrations/webhook.ts` before it reaches here -
 * this function deliberately cannot be called with unverified input, because
 * the verdict type is what carries the batch.
 *
 * Same vocabulary as the polled feed, mapped by the same connector, so the
 * observations are indistinguishable downstream apart from `encoding`. That is
 * what lets the dedupe key collapse a webhook and the poll's later re-report of
 * the same event into one record - and it is why the poll can safely overlap
 * its watermark rather than trying to abut it exactly.
 */
export function normaliseWebhooks(
  principal: Principal,
  inventory: Inventory,
  batches: RawBatch[],
): { observations: Observation[]; unhandled: number } {
  const observations: Observation[] = [];
  const available = connectorsFor(principal);
  let unhandled = 0;

  for (const batch of batches) {
    const connector = available.find((c) => batch.source.collector.startsWith(c.controller));
    if (!connector?.onWebhook) { unhandled += batch.records.length; continue; }

    try {
      const mapped = connector.onWebhook(batch, inventory);
      observations.push(...mapped);
      // A delivery whose alert type nothing maps is the NORMAL case, not an
      // error - these feeds carry a great deal that is not operationally
      // interesting. Counted rather than logged per record, so a noisy vendor
      // cannot flood the log.
      unhandled += Math.max(0, batch.records.length - mapped.length);
    } catch (err) {
      log.error('webhook normalise failed', {
        controller: connector.controller,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { observations, unhandled };
}

/** The external plane. Ours, not any vendor's. */
export function collectProbes(principal: Principal, inventory: Inventory): Observation[] {
  return probeEstate(principal, inventory);
}

// ---------------------------------------------------------------------------
// 2b. STREAM - batch, never one invocation per record
// ---------------------------------------------------------------------------

/**
 * Put normalised observations on the stream, partitioned by device.
 *
 * Partitioning by deviceId is the decision that matters: it gives ordering
 * where ordering is meaningful (one device's link up and link down must not
 * overtake each other, or the board shows a port permanently down that came
 * back seconds later) and parallelism everywhere else. Partitioning by site
 * instead would concentrate a large site's thousands of devices onto one shard
 * - the classic hot-partition mistake.
 */
export function enqueue(observations: Observation[]): void {
  observationStream.putRecords(
    observations.map((o) => ({ partitionKey: o.deviceId, data: o })),
  );
}

/**
 * The batched consumer. ONE invocation, MANY records.
 *
 * This is the shape an event-source mapping delivers, and writing the handler
 * to take an array rather than a record is what makes the arithmetic work: at
 * 30,000 records/sec, a batch size of 500 is ~60 invocations/sec instead of
 * 30,000.
 *
 * It reports per-record failures (ReportBatchItemFailures) rather than throwing.
 * Throwing fails the whole batch, and a batch that always fails is a shard that
 * never advances - the silent backlog that shows up as a rising iterator-age
 * metric hours later.
 */
export function processBatch(
  batch: Batch<Observation>,
): { result: BatchResult; observations: Observation[] } {
  const good: Observation[] = [];
  const failedIds: string[] = [];

  for (const record of batch.records) {
    const obs = record.data;
    // A record that cannot be understood is isolated, not fatal. This is where
    // a malformed payload from a vendor's bad firmware release gets quarantined
    // instead of stopping the estate.
    if (!obs || typeof obs.deviceId !== 'string' || !obs.observedAt) {
      failedIds.push(record.partitionKey + ':' + String(obs?.observationId));
      continue;
    }
    good.push(obs);
  }

  // The cold path, and the fork that keeps the operational store affordable.
  // Flows go to their OWN prefix in a different layout: they are the class
  // whose volume would otherwise make storage scale with traffic rather than
  // with incidents, and nothing operational ever reads them back.
  const flows = good.filter(isFlow);
  const operational = good.filter((o) => !isFlow(o));
  appendFlows(flows);
  appendHistory(operational);

  return { result: { failedIds }, observations: operational };
}

/**
 * Enqueue, then drain the stream through the batched consumer.
 *
 * In production these are two separate systems - a producer Lambda writes to
 * Kinesis, an event-source mapping invokes a consumer Lambda - and nothing
 * calls them in sequence like this. Doing so here is what makes the whole path
 * observable in one run.
 */
export async function streamAndCollect(
  observations: Observation[],
  options?: { batchSize?: number },
): Promise<Observation[]> {
  enqueue(observations);

  const collected: Observation[] = [];
  await observationStream.consume(
    (batch: Batch<unknown>) => {
      const { result, observations: good } = processBatch(batch as Batch<Observation>);
      collected.push(...good);
      return result;
    },
    (record: { partitionKey: string; data: unknown }) =>
      record.partitionKey + ':' + String((record.data as Observation)?.observationId),
    { batchSize: options?.batchSize ?? 500 },
  );

  return collected;
}

// ---------------------------------------------------------------------------
// 3. ENRICH - collapse duplicate witnesses, attach coordinates
// ---------------------------------------------------------------------------

/**
 * Collapse events that describe the same real-world transition.
 *
 * A port failure arrives as a webhook the instant it fires, and again in the
 * polled event log minutes later because the watermark deliberately overlaps.
 * They share a `dedupeKey` precisely so this step can fold them into one record
 * that remembers every witness.
 *
 * DOING THIS BEFORE THE RULES IS THE WHOLE POINT. Skip it and `evaluate` counts
 * four observations as four pieces of evidence, `isCorroborated` sees a well
 * corroborated alarm, and one unremarkable port flap pages somebody. The
 * surviving record keeps the union of planes, which is what makes the
 * corroboration check honest rather than inflated.
 */
export function collapseDuplicates(observations: Observation[]): Observation[] {
  const events = new Map<string, Observation>();
  const out: Observation[] = [];

  for (const o of observations) {
    if (!isEvent(o)) { out.push(o); continue; }

    const existing = events.get(o.dedupeKey);
    if (!existing || !isEvent(existing)) { events.set(o.dedupeKey, o); continue; }

    // Keep the earliest sighting - it is closest to when the thing happened -
    // but remember that the other feed saw it too.
    const keep = Date.parse(o.observedAt) < Date.parse(existing.observedAt) ? o : existing;
    const other = keep === o ? existing : o;

    events.set(o.dedupeKey, {
      ...keep,
      attributes: {
        ...keep.attributes,
        witnesses: String(Number(keep.attributes.witnesses ?? 1) + 1),
        alsoSeenBy: [String(keep.attributes.alsoSeenBy ?? ''), other.encoding]
          .filter(Boolean).join(','),
      },
    });
  }

  return [...out, ...events.values()];
}

/**
 * Attach the site's coordinates so an alarm can be put on a map.
 *
 * Devices know their own name, not their geography. Resolution is the join, and
 * doing it once at write time means every downstream read - the board, the
 * agent, the incident - gets a location for free.
 */
export function resolveLocations(principal: Principal, observations: Observation[]): Observation[] {
  return observations.map((o) => {
    if (o.siteId) return o;
    const where = locationOf(principal, o.deviceId);
    return where ? { ...o, siteId: where.siteId } : o;
  });
}

/**
 * Fold the newest observation for each device into the hot-state item.
 *
 * OVERWRITE, never append. This is the write that keeps the operational store
 * bounded by estate size rather than by message rate.
 */
export function foldDeviceState(principal: Principal, observations: Observation[]): DeviceState[] {
  const current = new Map(allDeviceStates(principal).map((d) => [d.deviceId, { ...d }]));

  // Down-ness has to be counted per interface, not accumulated: a port that
  // goes down and comes back within one batch is not two failures, and a
  // counter that only ever increments turns a flap into a permanent red light.
  const linkState = new Map<string, Map<string, string>>();

  for (const o of observations) {
    const device = current.get(o.deviceId);
    if (!device) continue;

    if (isMetric(o) && o.kind === 'cpu-utilisation') {
      device.cpuUtilisation = o.value;
      device.updatedAt = o.observedAt;
    }
    if (isMetric(o) && o.kind === 'reachability') {
      device.status = o.value === 0 ? 'down' : device.status === 'down' ? 'healthy' : device.status;
      device.updatedAt = o.observedAt;
    }
    if (isEvent(o) && o.kind === 'link-state' && o.interfaceId) {
      const ports = linkState.get(o.deviceId) ?? new Map<string, string>();
      ports.set(o.interfaceId, o.state);
      linkState.set(o.deviceId, ports);
      device.updatedAt = o.observedAt;
    }
  }

  for (const [deviceId, ports] of linkState) {
    const device = current.get(deviceId);
    if (!device) continue;
    device.interfacesDown = [...ports.values()].filter((s) => s !== 'up').length;
    if (device.status !== 'down' && device.interfacesDown > 0) device.status = 'degraded';
  }

  const next = [...current.values()];
  cacheDeviceStates(next);
  return next;
}

// ---------------------------------------------------------------------------
// 4. EVALUATE - deterministic rules, one device at a time -> Alarm[]
// ---------------------------------------------------------------------------

/**
 * Rules, applied per device. Deliberately NOT an LLM: what counts as an alarm
 * must be identical every time and explainable to the person it paged at 4am.
 * The model's job starts afterwards.
 *
 * An Alarm here is a CANDIDATE. It is not yet a page - corroboration and
 * merging happen in detectIncidents().
 */
export function evaluate(principal: Principal, observations: Observation[]): Alarm[] {
  const byDevice = new Map<string, Observation[]>();
  for (const o of observations) {
    const list = byDevice.get(o.deviceId) ?? [];
    list.push(o);
    byDevice.set(o.deviceId, list);
  }

  const alarms: Alarm[] = [];

  for (const [deviceId, deviceObs] of byDevice) {
    const where = locationOf(principal, deviceId);
    const location = { lon: where?.lon ?? 0, lat: where?.lat ?? 0 };
    const siteId = where?.siteId ?? deviceObs.find((o) => o.siteId)?.siteId ?? '';
    const uplink = uplinkChain(principal, deviceId)[0];

    const raise = (kind: AlarmKind, matching: Observation[], severity: Severity) => {
      alarms.push({
        tenantId: principal.tenantId,
        alarmId: alarmId(),
        deviceId,
        interfaceId: matching.find((m) => m.interfaceId)?.interfaceId,
        siteId,
        kind,
        severity,
        observationIds: matching.map((m) => m.observationId),
        // The DISTINCT vantage points that saw it. This is the field
        // detectIncidents corroborates on, so it has to be a set - two feeds
        // from the same box is one witness, not two.
        planes: [...new Set(matching.map((m) => m.plane))],
        location,
        uplinkDeviceId: uplink,
        raisedAt: nowIso(),
      });
    };

    const linksDown = deviceObs.filter(
      (o) => isEvent(o) && o.kind === 'link-state' && o.state !== 'up',
    );
    if (linksDown.length > 0) raise('link-down', linksDown, worst(linksDown));

    const unreachable = deviceObs.filter(
      (o) => isMetric(o) && o.kind === 'reachability' && o.value === 0,
    );
    if (unreachable.length > 0) raise('device-unreachable', unreachable, 'critical');

    const adjacency = deviceObs.filter(
      (o) => isEvent(o) && o.kind === 'protocol-adjacency' && o.state === 'lost',
    );
    if (adjacency.length > 0) raise('adjacency-lost', adjacency, worst(adjacency));

    const errors = deviceObs.filter(
      (o) => isMetric(o) && o.kind === 'interface-errors' && o.severity !== 'ok',
    );
    if (errors.length > 0) raise('interface-errors', errors, worst(errors));

    const saturated = deviceObs.filter(
      (o) => isMetric(o)
        && (o.kind === 'cpu-utilisation' || o.kind === 'interface-utilisation')
        && o.severity !== 'ok',
    );
    if (saturated.length > 0) raise('capacity-saturation', saturated, worst(saturated));

    const optical = deviceObs.filter(
      (o) => isMetric(o) && o.kind === 'optical-rx-power' && o.severity !== 'ok',
    );
    if (optical.length > 0) raise('optical-degradation', optical, worst(optical));

    const power = deviceObs.filter(
      (o) => isEvent(o) && o.kind === 'power-supply' && o.state === 'failed',
    );
    if (power.length > 0) raise('power-fault', power, 'critical');
  }

  return alarms;
}

function worst(observations: Observation[]): Severity {
  const rank = { ok: 0, info: 1, warning: 2, critical: 3 } as const;
  return observations.reduce<Severity>(
    (acc, o) => (rank[o.severity] > rank[acc] ? o.severity : acc),
    'ok',
  );
}

// ---------------------------------------------------------------------------
// 5. DETECT - corroborate and merge alarms into incidents
// ---------------------------------------------------------------------------

/**
 * Alarm kinds caused by something UPSTREAM of the device reporting them.
 *
 * These merge with each other, because one failure produces all of them at
 * once: a distribution switch dying makes its access switches unreachable, its
 * links go down, and its routing adjacencies drop. Raising "link down affecting
 * 40", "device unreachable affecting 40" and "adjacency lost affecting 12" as
 * three separate pages for one dead switch is the same double-paging the merge
 * rule exists to prevent, one level up.
 *
 * Everything else - interface errors, saturation, optical degradation, a failed
 * PSU - is about THAT box rather than its position in the tree, and never
 * merges. A switch with a dying optic next to an unrelated outage has two
 * separate problems, and an engineer needs to see both.
 */
const TOPOLOGY_CAUSED = new Set<AlarmKind>([
  'link-down', 'device-unreachable', 'adjacency-lost',
]);

/**
 * How far apart in time two alarms may be and still be one event.
 *
 * TEN MINUTES, and the bound is chosen from how failures actually propagate. A
 * dead distribution switch does not take its downstream estate offline
 * instantly: access switches notice within seconds, their access points time
 * out over a minute or two, and a routing adjacency can take three minutes to
 * be declared dead. Anything under about five minutes splits one outage into
 * several incidents that arrive as separate pages.
 *
 * An hour, the obvious safer-looking choice, is worse than it looks: a port
 * that flaps every few minutes all afternoon would collapse into a single
 * permanent incident, and the merge would stop being evidence of anything.
 */
const MERGE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Alarm kinds that do NOT need a second opinion.
 *
 * A power supply failure is a hardware fault reported by the chassis itself. It
 * is not a noisy inference from a sensor reading, there is nothing else in the
 * estate positioned to see it, and waiting for corroboration before acting on
 * it would be indefensible.
 *
 * NOTE HOW SHORT THIS LIST IS compared with the equivalent in a fleet platform,
 * and why. A truck's hours-of-service clock has exactly one source and no
 * second opinion is physically available, so the exemption carries real weight
 * there. Here almost everything genuinely can be corroborated - the device, its
 * controller and our own probe are three separate vantage points - so an
 * exemption is close to an admission that we did not look.
 */
const NEEDS_NO_CORROBORATION = new Set<AlarmKind>(['power-fault']);

/** How close two alarms must be to count as evidence of the same thing. */
const CORROBORATION_WINDOW_MS = 5 * 60 * 1000;

/**
 * Is there independent evidence for this alarm?
 *
 * TWO INDEPENDENT WITNESSES, and it matters enormously that "independent" is
 * not "two feeds". A Cisco switch losing a link emits a syslog line and an SNMP
 * trap from the same agent on the same box; that is one witness talking twice,
 * and a rule that counted feeds would treat every single port flap in the
 * estate as fully corroborated.
 *
 * What counts:
 *
 *   two PLANES        the device said so and its controller agrees, or our
 *                     probe cannot reach it. Genuinely different vantage points.
 *   the far end       the device at the OTHER end of the link raised the same
 *                     alarm. Same plane, but a different box - and two switches
 *                     agreeing a link is down is two witnesses by any reading.
 *   different evidence a second alarm of a different kind on the same device in
 *                     the same window. Saturation plus errors is a story;
 *                     either alone is noise.
 *
 * The hardest case is the one the external plane exists for: a device that is
 * powered off reports nothing, and its controller only knows it stopped
 * checking in. Without a probe there is no second witness available at all,
 * which is why `orbital-health` in the controller registry - a tenant with no
 * cloud controller - is worth keeping in the fixtures.
 */
function isCorroborated(principal: Principal, alarm: Alarm, all: Alarm[]): boolean {
  if (NEEDS_NO_CORROBORATION.has(alarm.kind)) return true;

  // Two independent vantage points saw it.
  if (alarm.planes.length >= 2) return true;

  const at = Date.parse(alarm.raisedAt);
  const inWindow = (other: Alarm) =>
    Math.abs(Date.parse(other.raisedAt) - at) <= CORROBORATION_WINDOW_MS;

  return all.some((other) => {
    if (other.alarmId === alarm.alarmId) return false;
    if (!inWindow(other)) return false;

    // The far end of the same link agreeing - a different box, so a different
    // witness even though both are on the device plane.
    if (other.kind === alarm.kind && other.deviceId !== alarm.deviceId) {
      return isUpstreamOf(principal, other.deviceId, alarm.deviceId)
        || isUpstreamOf(principal, alarm.deviceId, other.deviceId);
    }

    // Or a different kind of evidence for the same device, at the same moment.
    return other.deviceId === alarm.deviceId && other.kind !== alarm.kind;
  });
}

/**
 * Correlate alarms into incidents by ANCHORING each one at its cause.
 *
 * THE OBVIOUS ALGORITHM IS WRONG, and it is worth recording why, because it
 * looks right and it half-works. Seeding a cluster from one alarm and pulling
 * in everything "related" to it fails on the commonest case of all: two access
 * switches under one dead distribution switch are not related TO EACH OTHER -
 * neither sits above the other - so whichever one seeds first claims the
 * distribution switch, and the rest each become their own page. A dead switch
 * with three orphans below it produced three incidents instead of one.
 *
 * Geometry hides this. Two trucks near the same closure ARE near each other,
 * so a radius-based merge is symmetric and transitive by construction and a
 * seed-and-sweep works. Topology is a tree, and "is related to" across siblings
 * only holds THROUGH their parent - so the cluster has to be defined by the
 * parent, not discovered from a member.
 *
 * So: walk each alarm's uplink chain and anchor it at the HIGHEST device that
 * is also alarming. Every device beneath one failure anchors on that failure,
 * and one group falls out regardless of which alarm happened to be first in the
 * list. Alarms about the box itself rather than its position anchor on
 * themselves and never merge.
 */
export function detectIncidents(principal: Principal, alarms: Alarm[]): Incident[] {
  const corroborated = alarms.filter((a) => isCorroborated(principal, a, alarms));

  const topological = corroborated.filter((a) => TOPOLOGY_CAUSED.has(a.kind));
  const alarmingDevices = new Set(topological.map((a) => a.deviceId));

  /** The highest alarming device at or above this one. */
  const anchorOf = (alarm: Alarm): string => {
    if (!TOPOLOGY_CAUSED.has(alarm.kind)) return 'self:' + alarm.alarmId;

    let anchor = alarm.deviceId;
    // [self, parent, grandparent, ...] - the LAST alarming entry is the highest.
    for (const deviceId of [alarm.deviceId, ...uplinkChain(principal, alarm.deviceId)]) {
      if (alarmingDevices.has(deviceId)) anchor = deviceId;
    }
    return 'topo:' + alarm.siteId + ':' + anchor;
  };

  const groups = new Map<string, Alarm[]>();
  for (const alarm of corroborated) {
    const key = anchorOf(alarm);
    const list = groups.get(key);
    if (list) list.push(alarm); else groups.set(key, [alarm]);
  }

  const incidents: Incident[] = [];

  // Sorted so the output is deterministic: two runs of the demo must produce
  // identical incident ordering, or a diff of the output is noise.
  const ordered = [...groups.entries()].sort((a, b) =>
    Date.parse(earliest(a[1])) - Date.parse(earliest(b[1])) || a[0].localeCompare(b[0]));

  for (const [key, group] of ordered) {
    // Within one anchor, split on TIME. A port that flaps every few minutes all
    // afternoon anchors identically each time, and collapsing a whole
    // afternoon into one permanent incident would make the merge meaningless.
    for (const run of splitByWindow(group)) {
      const deviceIds = [...new Set(run.map((m) => m.deviceId))].sort();
      const anchorDevice = key.startsWith('topo:') ? key.split(':')[2] : deviceIds[0];
      const siteId = run[0].siteId;

      incidents.push({
        tenantId: principal.tenantId,
        incidentId: incidentId(),
        // Named after the most severe kind in the cluster, not the first alarm
        // in it - the first is just whichever arrived soonest.
        title: deviceIds.length > 1
          ? titleFor(dominantKind(run)) + ' affecting ' + deviceIds.length +
            ' devices at ' + siteId
          : titleFor(dominantKind(run)) + ' - ' + deviceIds[0],
        severity: worstAlarm(run),
        status: 'open',
        siteId,
        deviceIds,
        alarmIds: run.map((m) => m.alarmId),
        // The anchor IS the root cause: it is the highest thing alarming, and
        // everything else in the cluster hangs off it. This is the single most
        // useful thing correlation can tell a human at 4am.
        rootCauseDeviceId: anchorDevice,
        openedAt: nowIso(),
      });
    }
  }

  return incidents;
}

function earliest(alarms: Alarm[]): string {
  return alarms.reduce((acc, a) => (a.raisedAt < acc ? a.raisedAt : acc), alarms[0].raisedAt);
}

/**
 * Split one anchor's alarms into time-contiguous runs.
 *
 * Contiguous rather than bucketed on purpose. Fixed buckets put two alarms a
 * minute apart into different incidents whenever they straddle a boundary,
 * which is arbitrary and shows up as an intermittent, unreproducible split.
 */
function splitByWindow(group: Alarm[]): Alarm[][] {
  const sorted = [...group].sort((a, b) => Date.parse(a.raisedAt) - Date.parse(b.raisedAt));
  const runs: Alarm[][] = [];
  let run: Alarm[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = Date.parse(sorted[i].raisedAt) - Date.parse(run[run.length - 1].raisedAt);
    if (gap <= MERGE_WINDOW_MS) run.push(sorted[i]);
    else { runs.push(run); run = [sorted[i]]; }
  }
  runs.push(run);
  return runs;
}

/**
 * Which kind names a merged incident.
 *
 * Ordered by how much it tells the engineer. "Device unreachable affecting 40"
 * sends someone to the right rack; "link down affecting 40" describes the same
 * outage far less usefully.
 */
const KIND_PRIORITY: AlarmKind[] = [
  'power-fault', 'device-unreachable', 'link-down', 'adjacency-lost',
  'optical-degradation', 'interface-errors', 'capacity-saturation',
];

function dominantKind(alarms: Alarm[]): AlarmKind {
  for (const kind of KIND_PRIORITY) {
    if (alarms.some((a) => a.kind === kind)) return kind;
  }
  return alarms[0].kind;
}

function titleFor(kind: AlarmKind): string {
  const titles: Record<AlarmKind, string> = {
    'link-down': 'Link down',
    'device-unreachable': 'Device unreachable',
    'adjacency-lost': 'Routing adjacency lost',
    'interface-errors': 'Interface errors',
    'capacity-saturation': 'Capacity saturation',
    'optical-degradation': 'Optical degradation',
    'power-fault': 'POWER FAULT',
  };
  return titles[kind];
}

function worstAlarm(alarms: Alarm[]): Severity {
  const rank = { ok: 0, info: 1, warning: 2, critical: 3 } as const;
  return alarms.reduce<Severity>(
    (acc, a) => (rank[a.severity] > rank[acc] ? a.severity : acc),
    'ok',
  );
}

/** How deep the affected subtree runs - useful context for the responder. */
export function incidentDepth(principal: Principal, incident: Incident): number {
  if (!incident.rootCauseDeviceId) return 0;
  return incident.deviceIds.reduce((deepest, deviceId) => {
    const hops = uplinkChain(principal, deviceId)
      .indexOf(incident.rootCauseDeviceId!);
    return Math.max(deepest, hops + 1);
  }, 0);
}

// ---------------------------------------------------------------------------
// 6. PUBLISH - persist, then announce
// ---------------------------------------------------------------------------

/**
 * Write first, publish second. If the event fires before the write lands, a
 * subscriber can query for the incident and get a 404 - a real and very
 * annoying race. (The rigorous fix is the transactional outbox pattern: write
 * the event into the same DynamoDB transaction and let a DynamoDB Streams
 * handler publish it. Worth naming if asked about exactly-once.)
 *
 * NOTHING HERE PUBLISHES OBSERVATIONS, and that is the load-bearing decision of
 * the whole architecture. Observations are persisted and folded into hot state;
 * only alarms and incidents reach the bus. That is what keeps bus and consumer
 * cost proportional to *incidents* rather than to *estate size*.
 */
export async function publish(
  principal: Principal,
  observations: Observation[],
  devices: DeviceState[],
  alarms: Alarm[],
  incidents: Incident[],
) {
  putObservations(principal, observations);
  putDeviceStates(principal, devices);
  putAlarms(principal, alarms);
  for (const incident of incidents) putIncident(principal, incident);

  // AFTER the write, never before.
  //
  // The watermark records what we have PERSISTED, not what we fetched. Advance
  // it at collect time and a crash between the fetch and the write loses that
  // window permanently - the next poll asks for everything after it, the gap is
  // never re-requested, and nothing anywhere reports a problem. In production
  // this is part of the same transaction as the PutItem above.
  advanceWatermarks(principal, observations);

  for (const alarm of alarms) {
    await bus.putEvents({
      source: 'netpulse.evaluate',
      detailType: 'AlarmRaised',
      // Put the fields rules will filter on at the TOP level of detail -
      // EventBridge patterns match on structure, and deeply nested fields make
      // for fragile patterns.
      detail: {
        tenantId: alarm.tenantId,
        alarmId: alarm.alarmId,
        deviceId: alarm.deviceId,
        siteId: alarm.siteId,
        kind: alarm.kind,
        severity: alarm.severity,
      },
    });
  }

  for (const incident of incidents) {
    await bus.putEvents({
      source: 'netpulse.detect',
      detailType: 'IncidentOpened',
      detail: {
        tenantId: incident.tenantId,
        incidentId: incident.incidentId,
        severity: incident.severity,
        siteId: incident.siteId,
        deviceIds: incident.deviceIds,
        rootCauseDeviceId: incident.rootCauseDeviceId,
        title: incident.title,
      },
    });
  }

  return {
    observations: observations.length,
    devices: devices.length,
    alarms: alarms.length,
    incidents: incidents.length,
  };
}

/** Convenience for callers that just want the estate's inventory. */
export { getInventory };

/** Re-exported so the workflow and the demo agree on what a plane is. */
export type { ObservationPlane };

/**
 * Move each resource's watermark to the newest observation we just persisted.
 *
 * Keyed on the encoding rather than the resource name because a webhook and a
 * poll can both carry the same event, and only the POLL's watermark should
 * move - a webhook arriving out of order must never advance the sweep past a
 * window the sweep has not read. Records that arrived by webhook are therefore
 * skipped here entirely.
 *
 * Takes the MAXIMUM observedAt rather than the last element: observations come
 * back from a cloud in whatever order it felt like, and assuming the last row
 * is the newest is how a watermark jumps backwards and re-processes an hour.
 */
function advanceWatermarks(principal: Principal, observations: Observation[]): void {
  const newest = new Map<string, string>();

  for (const o of observations) {
    if (o.encoding !== 'rest-json') continue;
    const resource = String(o.attributes.resource ?? '');
    const controller = String(o.attributes.controller ?? '');
    if (!resource || !controller) continue;

    const key = controller + '|' + resource;
    const current = newest.get(key);
    if (!current || o.observedAt > current) newest.set(key, o.observedAt);
  }

  for (const [key, through] of newest) {
    const [controller, resource] = key.split('|');
    setWatermark({ tenantId: principal.tenantId, controller, resource, through });
  }
}

// ---------------------------------------------------------------------------
// Scenario replay
// ---------------------------------------------------------------------------

/**
 * Run one scenario's feeds through the real ingest path.
 *
 * Lives HERE rather than in the demo or the board because both replay the same
 * scenarios and both must get the same answer. When this was duplicated, the
 * board and the demo disagreed about whether a scenario paged - and the board
 * was the one that was wrong, which is the worse way round.
 *
 * Webhook feeds go through `onWebhook`, polled feeds through `normalise` with
 * their resource, because that is where the plane comes from. Routing them
 * identically would be the whole bug this refactor exists to prevent.
 */
export function runScenarioFeeds(
  principal: Principal,
  inventory: Inventory,
  feeds: Array<{ controller: string; resource: string; records: unknown[] }>,
  receivedAt: string,
): { observations: Observation[]; unresolved: string[] } {
  const available = connectorsFor(principal);
  const out: Observation[] = [];

  // Drain anything a previous scenario left behind, so the count reported is
  // this scenario's and not the suite's running total.
  inventory.takeUnresolved();

  for (const feed of feeds) {
    const connector = available.find((c) => c.controller === feed.controller);
    if (!connector) continue;

    const raw: RawBatch = {
      tenantId: principal.tenantId,
      encoding: feed.resource === 'webhook' ? 'webhook' : 'rest-json',
      receivedAt,
      source: { collector: feed.controller + '-scenario', resource: feed.resource },
      records: feed.records,
    };

    if (feed.resource === 'webhook') {
      out.push(...(connector.onWebhook?.(raw, inventory) ?? []));
      continue;
    }

    const resource = connector.resources.find((r) => r.name === feed.resource);
    if (!resource) continue;
    out.push(...connector.normalise(raw, inventory, resource));
  }

  return { observations: out, unresolved: inventory.takeUnresolved() };
}
