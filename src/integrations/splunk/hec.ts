/**
 * ---------------------------------------------------------------------------
 * Splunk HTTP Event Collector
 * ---------------------------------------------------------------------------
 * Splunk is where this customer's OTHER machine data already lives - firewall
 * logs, VPN, Active Directory, endpoint. Their NOC watches it. So the useful
 * question is not "should we adopt Splunk" but "what, exactly, do we send it",
 * and the answer is decided by how Splunk is priced.
 *
 * SPLUNK BILLS BY INDEXED VOLUME PER DAY. Not by query, not by node - by how
 * many gigabytes you push into it. That single fact settles the design:
 *
 *   observations  NO. An estate produces far more observations than decisions,
 *                 and indexing them would make the licence scale with estate
 *                 size. This is the SAME argument as "observations never reach
 *                 the event bus", for the same reason, and it lands twice as
 *                 hard here because the bill is metered rather than amortised.
 *   alarms        YES. Small, already filtered by the rules.
 *   incidents     YES. Tiny, and the thing a NOC actually pages on.
 *
 * So Splunk is a third consumer on the EventBridge bus, beside the pager and
 * Slack. That is precisely what the bus was for: "also send it to Splunk" is a
 * RULE, not a change to anything that produces events. Nothing upstream of the
 * bus knows Splunk exists.
 *
 * WHERE THE BULK DATA STILL GOES: S3, queried with Athena. The two are not
 * competing. Athena is cheap per terabyte and slow to iterate on; Splunk is
 * expensive per gigabyte, interactive, and - decisively - already holds the
 * firewall and identity data that an operator wants to correlate against at
 * 4am. Sending the cold path to Splunk would buy a worse Athena at fifty times
 * the price.
 *
 * HEC IS THE INTEGRATION POINT. It is an HTTPS endpoint on the Splunk indexer
 * (or a load balancer in front of a tier of them) that accepts JSON over POST
 * with a token. No forwarder agent to install, no syslog, nothing to run.
 */
import { nowIso, now } from '../../platform/clock.ts';
import { log } from '../../platform/logger.ts';
import { env } from '../../platform/env.ts';
import type { AlarmEventDetail, IncidentEventDetail } from '../../platform/types.ts';

/**
 * One event, in the envelope HEC expects.
 *
 * The metadata fields are OUTSIDE `event`, and that is not cosmetic: Splunk
 * uses them for routing and retention before it ever looks at the payload.
 */
export type HecEvent = {
  /**
   * EPOCH SECONDS. Not milliseconds.
   *
   * THE MISTAKE EVERYONE MAKES ONCE, and it does not error. Send milliseconds
   * and Splunk cheerfully indexes your alarm with a timestamp somewhere around
   * the year 56000. It does not appear in any search over a sane time range, it
   * does not appear in "all time" sorted by recency, and the index looks empty
   * while the licence meter runs. Fractional seconds are fine and are how you
   * keep sub-second ordering.
   */
  time: number;
  /** The device or service the event is ABOUT, not the host that sent it. */
  host: string;
  /** Free-form origin. Ours is always the platform, per stream. */
  source: string;
  /**
   * The parse instruction. Splunk picks field extraction, line breaking and
   * timestamp recognition from this, so a sourcetype that changes shape between
   * releases breaks every saved search the customer has written against it.
   * Treat it as a published interface: version it rather than mutating it.
   */
  sourcetype: string;
  /** Which index. Drives retention and, critically, who is allowed to see it. */
  index: string;
  /**
   * Indexed fields.
   *
   * Top-level `fields` are indexed at write time, which makes them fast to
   * filter on and EXPENSIVE to have many of - each one costs index space on
   * every event. Put the handful an operator filters by here (tenant, site,
   * severity) and leave everything else inside `event`, where it is still
   * searchable but costs nothing extra.
   */
  fields: Record<string, string | number>;
  event: Record<string, unknown>;
};

export type HecConfig = {
  /** `https://<host>:8088/services/collector/event` */
  url: string;
  /** A HEC token. In production this is a Secrets Manager lookup per tenant. */
  token: string;
  index: string;
  /**
   * Whether to ask for indexer acknowledgement.
   *
   * WITHOUT IT A 200 MEANS "QUEUED", NOT "INDEXED". Splunk accepts the batch
   * into a memory queue and returns immediately; if the indexer falls over
   * before it flushes, the events are gone and you were told everything was
   * fine. With ack you get a channel id back and poll for it, which is slower
   * and is the right default for anything a NOC pages on.
   */
  useAck: boolean;
};

export function hecConfig(): HecConfig {
  return {
    url: env('SPLUNK_HEC_URL', 'https://splunk.internal:8088/services/collector/event'),
    token: env('SPLUNK_HEC_TOKEN', 'demo-only-not-a-real-hec-token'),
    index: env('SPLUNK_INDEX', 'netpulse'),
    useAck: true,
  };
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/**
 * The sourcetypes this platform publishes.
 *
 * VERSIONED IN THE NAME, deliberately. The customer will write saved searches,
 * dashboards and correlation rules against these, and those are their code, not
 * ours. Renaming a field inside `netpulse:alarm:v1` silently breaks a dashboard
 * we cannot see; publishing `:v2` beside it does not.
 */
export const SOURCETYPES = {
  alarm: 'netpulse:alarm:v1',
  incident: 'netpulse:incident:v1',
} as const;

/** Splunk wants epoch SECONDS, with fractions for sub-second ordering. */
function toEpochSeconds(iso: string): number {
  const ms = Date.parse(iso);
  return (Number.isNaN(ms) ? now() : ms) / 1000;
}

/**
 * Shape an alarm for Splunk from WHAT THE BUS CARRIED.
 *
 * Takes the projection, not the full `Alarm`. An earlier cut took `Alarm` and
 * read `alarm.planes.length`; the cast compiled, the bus had never carried
 * `planes`, and every single delivery threw. The type is the fix - see
 * `AlarmEventDetail`.
 *
 * There is no timestamp on the projection either, which is why `raisedAt` is
 * carried: without it Splunk stamps the event with INGEST time, and a backlog
 * replayed after an outage lands as if it all happened at once.
 */
export function alarmToHec(alarm: AlarmEventDetail, index: string): HecEvent {
  return {
    time: toEpochSeconds(alarm.raisedAt),
    // The DEVICE, not our Lambda. `host` is what an operator pivots on in
    // Splunk, and filling it with the sender makes every one of our events look
    // like it came from the same machine.
    host: alarm.deviceId,
    source: 'netpulse:evaluate',
    sourcetype: SOURCETYPES.alarm,
    index,
    fields: {
      tenant: alarm.tenantId,
      site: alarm.siteId,
      severity: alarm.severity,
      kind: alarm.kind,
      // The number an operator most often filters on, and the one that
      // explains why an alarm did or did not page.
      planes: alarm.planeCount,
    },
    event: {
      alarmId: alarm.alarmId,
      deviceId: alarm.deviceId,
      interfaceId: alarm.interfaceId,
      kind: alarm.kind,
      severity: alarm.severity,
      planeCount: alarm.planeCount,
      raisedAt: alarm.raisedAt,
    },
  };
}

export function incidentToHec(
  incident: IncidentEventDetail,
  index: string,
): HecEvent {
  return {
    time: toEpochSeconds(incident.openedAt),
    // The ROOT CAUSE device where correlation found one. An incident about
    // forty devices has to pivot on the one worth visiting, not on an
    // arbitrary member of the set.
    host: incident.rootCauseDeviceId ?? incident.siteId,
    source: 'netpulse:detect',
    sourcetype: SOURCETYPES.incident,
    index,
    fields: {
      tenant: incident.tenantId,
      site: incident.siteId,
      severity: incident.severity,
      status: incident.status,
      deviceCount: incident.deviceIds.length,
    },
    event: {
      incidentId: incident.incidentId,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      siteId: incident.siteId,
      deviceIds: incident.deviceIds,
      alarmIds: incident.alarmIds,
      rootCauseDeviceId: incident.rootCauseDeviceId,
      openedAt: incident.openedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// The wire format
// ---------------------------------------------------------------------------

/**
 * Serialise a batch the way HEC actually wants it.
 *
 * NEWLINE-DELIMITED JSON OBJECTS, **not** a JSON array. Sending
 * `[{...},{...}]` returns a cheerful 200 and indexes a single event whose
 * payload is the whole array - so the data is technically "in Splunk" and
 * every search the customer writes against it returns nothing. It is the
 * second-most-common HEC mistake after the millisecond timestamp, and it fails
 * exactly as quietly.
 */
export function serialiseBatch(events: HecEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/**
 * How many events to put in one POST.
 *
 * Batching matters: one request per alarm turns a cascade into a few hundred
 * HTTPS round trips against an indexer that is rate-limited per token. A few
 * hundred per request is well inside HEC's payload ceiling and turns the same
 * cascade into one call.
 */
export const HEC_BATCH_SIZE = 200;

export type HecResult = {
  batches: number;
  events: number;
  /** Events HEC refused. Kept, not dropped - see the note in `send`. */
  failed: HecEvent[];
};

/** What a real HEC POST returns. 0 is success; anything else is not. */
export type HecResponse = { code: number; text: string; ackId?: number };

/**
 * The transport, injected.
 *
 * Same seam as the clock and the prober: the demo and the tests must not open a
 * socket, and the production implementation is a `fetch` with the token in an
 * `Authorization: Splunk <token>` header. Injecting it also means the retry and
 * batching logic here is tested for real rather than mocked around.
 */
export type HecTransport = (body: string, config: HecConfig) => Promise<HecResponse>;

/** Accepts everything. The offline default. */
export const acceptingTransport: HecTransport = () =>
  Promise.resolve({ code: 0, text: 'Success', ackId: 1 });

let transport: HecTransport = acceptingTransport;
export function setHecTransport(t: HecTransport): void { transport = t; }
export function resetHecTransport(): void { transport = acceptingTransport; }

/** Everything sent this process. The demo prints it; tests assert on it. */
export const hecSent: HecEvent[] = [];

/**
 * Send a batch of events to HEC.
 *
 * FAILURES ARE RETURNED, NOT THROWN. A Splunk outage must not fail the ingest
 * run: the alarms are already in DynamoDB, already on the bus, and already
 * paging whoever needed paging. Splunk is a mirror for the customer's existing
 * console, and a mirror being unavailable is not an incident in its own right.
 * The refused events come back so the caller can decide - in production, onto
 * an SQS queue for replay.
 *
 * NOTE WHAT IS NOT HERE: idempotency. HEC has no de-duplication key, so a retry
 * after a timeout genuinely can double-index. That is why `alarmId` is inside
 * every event - the customer's saved searches can `dedup alarmId`, which is the
 * honest answer rather than pretending the transport is exactly-once.
 */
export async function send(events: HecEvent[], config = hecConfig()): Promise<HecResult> {
  const result: HecResult = { batches: 0, events: 0, failed: [] };

  for (let i = 0; i < events.length; i += HEC_BATCH_SIZE) {
    const batch = events.slice(i, i + HEC_BATCH_SIZE);
    result.batches++;

    try {
      const res = await transport(serialiseBatch(batch), config);
      if (res.code !== 0) {
        log.warn('splunk HEC refused a batch', { code: res.code, text: res.text });
        result.failed.push(...batch);
        continue;
      }
      result.events += batch.length;
      hecSent.push(...batch);
    } catch (err) {
      log.error('splunk HEC unreachable, continuing', {
        error: err instanceof Error ? err.message : String(err),
      });
      result.failed.push(...batch);
    }
  }

  log.info('splunk HEC delivery', {
    batches: result.batches, events: result.events, failed: result.failed.length, at: nowIso(),
  });
  return result;
}

export function resetHecSent(): void { hecSent.length = 0; }
