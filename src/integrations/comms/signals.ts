/**
 * ---------------------------------------------------------------------------
 * Comms signals: what the call and queue data says, aggregated
 * ---------------------------------------------------------------------------
 * The comms analogue of an Observation - but ALREADY AGGREGATED, and that is
 * the decision this file rests on.
 *
 * A call record is to the comms side what a flow record is to the network
 * side: bulk, per-event, and far more numerous than the decisions made from
 * it. The rule that keeps flows out of the operational store applies for the
 * same reason - storing and evaluating per call would make cost scale with
 * CALL VOLUME rather than with incidents. So individual records stay in the
 * raw archive, and what reaches the rules is one number per (subject, kind,
 * window): a failure rate, a share of degraded calls, a backlog.
 *
 * A RATE NEEDS A SAMPLE. Two failures in three calls is 67% and means nothing;
 * a rate is only emitted when `sampleSize` reaches `minSamples`, and a subject
 * below it produces no signal at all rather than a confident-looking number.
 *
 * SUBJECTS, NOT DEVICES. What goes wrong here is a trunk, a facility's network
 * or a queue. None of them is a network device, which is why these do not
 * reuse `Observation`, `Alarm` or `Incident` - all three are keyed on a
 * DeviceId, and a fake one would propagate into every consumer on the bus.
 *
 * FACILITY ATTRIBUTION GOES THROUGH THE WORKFORCE. Neither Graph nor Webex
 * puts a building on a call; they put people on it. The workforce join is
 * what turns "Harper's call was bad" into "a call at LC=1120 was bad", which
 * is why it had to exist first.
 */
import { sha256 } from '../../platform/crypto.ts';
import type { Severity, TenantId } from '../../platform/types.ts';
import type { CommsClient } from './client.ts';
import { drainGenesys, drainGraph, drainWebex } from './client.ts';
import type { CommsSource, CommsTenantConfig } from './types.ts';
import type { WorkforceMember, WorkforceReport } from './workforce.ts';

export type CommsSignalKind =
  | 'trunk-call-failure'          // Teams Direct Routing: failed / attempted, per SBC
  | 'facility-media-degradation'  // Teams or Webex: degraded share of media, per facility
  | 'queue-backlog'               // Genesys: callers waiting right now
  | 'queue-abandonment';          // Genesys: abandoned / offered, per queue

export type CommsSubject = { kind: 'trunk' | 'facility' | 'queue'; id: string; name: string };

export type CommsSignal = {
  tenantId: TenantId;
  /** Content hash, so re-evaluating the same window is idempotent. */
  signalId: string;
  source: CommsSource;
  subject: CommsSubject;
  kind: CommsSignalKind;
  value: number;
  unit: 'ratio' | 'count';
  /** What the value was computed over: calls, participant-minutes, offers. */
  sampleSize: number;
  window: { from: string; to: string };
  severity: Severity;
  /** One human sentence. What the agent and the board show. */
  detail: string;
};

/**
 * Every comms threshold, in one place - the same discipline as
 * UTILISATION_THRESHOLDS: a board colour that disagreed with the rule would be
 * the symptom.
 *
 * STARTING VALUES, not tuned ones. Each is a guess from vendor guidance and
 * should be revisited against a month of the customer's real data.
 */
export const COMMS_THRESHOLDS = {
  /** Failed / attempted calls on one SBC. */
  trunkFailure: { warning: 0.1, critical: 0.3, minSamples: 10 },
  /** Share of media samples over the jitter or loss limit at one facility. */
  mediaDegradation: { warning: 0.25, critical: 0.5, minSamples: 10 },
  /** Per-stream limits that make a sample "degraded". ITU-ish voice guidance. */
  degradedMedia: { jitterMs: 30, packetLossPercent: 5 },
  /** Callers waiting in one queue right now. Counts; no sample size. */
  queueBacklog: { warning: 8, critical: 15 },
  /**
   * Abandoned / offered in the window.
   *
   * The warning line is 15%, not the 10% often quoted, because at twenty-odd
   * offers a queue abandoning a normal 3% crosses 10% on three unlucky
   * callers - the first run of this against the mock warned on exactly that.
   */
  queueAbandonment: { warning: 0.15, critical: 0.25, minSamples: 20 },
} as const;

/** How far back a signal looks. Long enough to reach a sample, short enough to be "now". */
export const SIGNAL_WINDOW_MS = 30 * 60 * 1000;

function severityFor(value: number, t: { warning: number; critical: number }): Severity {
  if (value >= t.critical) return 'critical';
  if (value >= t.warning) return 'warning';
  return 'ok';
}

function signal(args: Omit<CommsSignal, 'signalId'>): CommsSignal {
  return {
    signalId: sha256([args.tenantId, args.source, args.subject.kind, args.subject.id, args.kind, args.window.from].join('|')).slice(0, 24),
    ...args,
  };
}

const pct = (r: number) => (r * 100).toFixed(0) + '%';

/**
 * ISO-8601 duration -> milliseconds. Graph writes jitter as `PT0.018S`, and
 * Number() on that is NaN - which compares false against every threshold, so
 * a parse that failed quietly would make every bad call look fine. This one
 * THROWS on anything it does not understand.
 */
export function isoDurationMs(d: string): number {
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(d);
  if (!m || d === 'PT') throw new Error('not an ISO-8601 time duration: ' + d);
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
}

type Window = { from: number; to: number };

function isoWindow(w: Window) {
  return { from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString() };
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

type DirectRoutingRow = { trunkFullyQualifiedDomainName: string; successfulCall: boolean; finalSipCode: number };

async function teamsTrunkSignals(client: CommsClient, w: Window): Promise<CommsSignal[]> {
  const { from, to } = isoWindow(w);
  const rows = (await drainGraph<DirectRoutingRow>(client, client.endpoints.graph +
    '/communications/callRecords/getDirectRoutingCalls(fromDateTime=' + from + ',toDateTime=' + to + ')')).rows;

  const byTrunk = new Map<string, DirectRoutingRow[]>();
  for (const r of rows) {
    const list = byTrunk.get(r.trunkFullyQualifiedDomainName);
    if (list) list.push(r); else byTrunk.set(r.trunkFullyQualifiedDomainName, [r]);
  }

  const t = COMMS_THRESHOLDS.trunkFailure;
  const out: CommsSignal[] = [];
  for (const [trunk, calls] of [...byTrunk].sort(([a], [b]) => a.localeCompare(b))) {
    if (calls.length < t.minSamples) continue;
    const failed = calls.filter((c) => !c.successfulCall);
    const rate = failed.length / calls.length;
    const codes = [...new Set(failed.map((c) => c.finalSipCode))].sort().join(', ');
    out.push(signal({
      tenantId: client.tenantId, source: 'teams',
      subject: { kind: 'trunk', id: trunk, name: trunk },
      kind: 'trunk-call-failure', value: rate, unit: 'ratio', sampleSize: calls.length,
      window: { from, to }, severity: severityFor(rate, t),
      detail: failed.length + ' of ' + calls.length + ' calls failed on ' + trunk +
        (codes ? ' (SIP ' + codes + ')' : ''),
    }));
  }
  return out;
}

type CallRecordSummary = { id: string; startDateTime: string };
type CallRecordFull = {
  participants_v2: Array<{ id: string }>;
  sessions: Array<{ segments: Array<{ media: Array<{ streams: Array<{ averageJitter: string; averagePacketLossRate: number }> }> }> }>;
};

/**
 * Per facility: the share of Teams calls with a degraded stream.
 *
 * A call is charged to EVERY participant's facility, because the record does
 * not say whose network hurt it. That over-attributes to the far end of a bad
 * site's calls - which is why a facility is only flagged when MOST of its
 * calls are bad: the far ends have enough other, clean calls to stay below
 * the line, and the bad site does not.
 *
 * ONE GET PER CALL RECORD, because quality lives under `sessions.segments`
 * and only the single-record endpoint expands it. Fine for a window of a few
 * dozen calls; at production volume the answer is Graph's callRecord change
 * notification, which pushes ids as calls end instead of having us list them.
 */
async function teamsMediaSignals(client: CommsClient, w: Window, members: Map<string, WorkforceMember>): Promise<CommsSignal[]> {
  const { from, to } = isoWindow(w);
  const g = client.endpoints.graph;
  const list = (await drainGraph<CallRecordSummary>(client,
    g + '/communications/callRecords?$filter=' + encodeURIComponent('startDateTime ge ' + from + ' and startDateTime lt ' + to))).rows;

  const byEntraId = new Map<string, WorkforceMember>();
  for (const m of members.values()) {
    const id = m.accounts.teams?.sourceUserId;
    if (id) byEntraId.set(id, m);
  }

  const lim = COMMS_THRESHOLDS.degradedMedia;
  const tally = new Map<string, { calls: number; degraded: number }>();
  for (const summary of list) {
    const full = await (await client.request('teams',
      g + '/communications/callRecords/' + summary.id + '?$expand=sessions($expand=segments)')).json() as CallRecordFull;
    const streams = full.sessions.flatMap((s) => s.segments.flatMap((seg) => seg.media.flatMap((m) => m.streams)));
    const degraded = streams.some((s) =>
      isoDurationMs(s.averageJitter) > lim.jitterMs || s.averagePacketLossRate * 100 > lim.packetLossPercent);

    const facilities = new Set(full.participants_v2
      .map((p) => byEntraId.get(p.id)?.facility?.code)
      .filter((c): c is string => c !== undefined));
    for (const code of facilities) {
      const t = tally.get(code) ?? { calls: 0, degraded: 0 };
      t.calls++;
      if (degraded) t.degraded++;
      tally.set(code, t);
    }
  }
  return facilitySignals(client.tenantId, 'teams', tally, { from, to }, 'calls');
}

function facilitySignals(
  tenantId: TenantId, source: CommsSource,
  tally: Map<string, { calls: number; degraded: number }>,
  window: { from: string; to: string }, unit: string,
): CommsSignal[] {
  const t = COMMS_THRESHOLDS.mediaDegradation;
  return [...tally]
    .filter(([, v]) => v.calls >= t.minSamples)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, v]) => {
      const share = v.degraded / v.calls;
      return signal({
        tenantId, source,
        subject: { kind: 'facility', id: code, name: 'LC=' + code },
        kind: 'facility-media-degradation', value: share, unit: 'ratio', sampleSize: v.calls,
        window, severity: severityFor(share, t),
        detail: pct(share) + ' of ' + v.calls + ' ' + unit + ' degraded at LC=' + code + ' (' + source + ')',
      });
    });
}

// ---------------------------------------------------------------------------
// Webex
// ---------------------------------------------------------------------------

type WebexMeetingRow = { id: string; start: string; end: string };
type WebexQualityRow = { webexUserEmail: string; audioIn: Array<{ packetLoss: number[]; jitter: number[] }> };

/**
 * Per facility: the share of participant-MINUTES with degraded audio.
 *
 * Minutes, not meetings, because a facility has only a handful of meetings in
 * a window and a rate over four meetings is not a rate. Attribution is clean
 * here, unlike Teams: each quality row is one participant's own measurement.
 * Units are ms and percent - see the mock's note on verifying them.
 */
async function webexMediaSignals(client: CommsClient, w: Window, members: Map<string, WorkforceMember>): Promise<CommsSignal[]> {
  const { from, to } = isoWindow(w);
  // Ask for meetings that STARTED up to an hour before the window, then keep
  // those that overlap it: a meeting that began at 13:50 and is still running
  // is squarely in a 14:00-14:30 window.
  const since = new Date(w.from - 60 * 60 * 1000).toISOString();
  const meetings = (await drainWebex<WebexMeetingRow>(client, client.endpoints.webexApi +
    '/meetings?meetingType=meeting&state=ended&from=' + since + '&to=' + to + '&max=100')).rows
    .filter((m) => Date.parse(m.end) >= w.from && Date.parse(m.start) < w.to);

  const lim = COMMS_THRESHOLDS.degradedMedia;
  const tally = new Map<string, { calls: number; degraded: number }>();
  for (const m of meetings) {
    const rows = (await drainWebex<WebexQualityRow>(client,
      client.endpoints.webexAnalytics + '/meeting/qualities?meetingId=' + encodeURIComponent(m.id) + '&max=1000')).rows;
    for (const r of rows) {
      const code = members.get(r.webexUserEmail.toLowerCase())?.facility?.code;
      if (!code) continue;
      const t = tally.get(code) ?? { calls: 0, degraded: 0 };
      for (const a of r.audioIn) {
        for (let i = 0; i < a.packetLoss.length; i++) {
          t.calls++;
          if (a.packetLoss[i] > lim.packetLossPercent || (a.jitter[i] ?? 0) > lim.jitterMs) t.degraded++;
        }
      }
      tally.set(code, t);
    }
  }
  return facilitySignals(client.tenantId, 'webex', tally, { from, to }, 'participant-minutes');
}

// ---------------------------------------------------------------------------
// Genesys
// ---------------------------------------------------------------------------

type QueueRow = { id: string; name: string };
type ObservationResult = { group: { queueId: string }; data: Array<{ metric: string; stats: { count: number } }> };
type AggregateResult = {
  group: { queueId: string };
  data: Array<{ metrics: Array<{ metric: string; stats: { count?: number } }> }>;
};

async function genesysQueueSignals(client: CommsClient, w: Window): Promise<CommsSignal[]> {
  const { from, to } = isoWindow(w);
  const api = client.endpoints.genesysApi;
  const queues = (await drainGenesys<QueueRow>(client, '/api/v2/routing/queues')).rows;
  const names = new Map(queues.map((q) => [q.id, q.name]));
  const filter = { type: 'or', predicates: queues.map((q) => ({ dimension: 'queueId', value: q.id })) };
  const post = async <T>(path: string, body: unknown): Promise<T> =>
    (await (await client.request('genesys', api + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()) as T;

  const out: CommsSignal[] = [];
  const subject = (id: string): CommsSubject => ({ kind: 'queue', id, name: names.get(id) ?? id });

  const obs = await post<{ results: ObservationResult[] }>('/api/v2/analytics/queues/observations/query',
    { filter, metrics: ['oWaiting'] });
  for (const r of obs.results) {
    const waiting = r.data.find((d) => d.metric === 'oWaiting')?.stats.count ?? 0;
    out.push(signal({
      tenantId: client.tenantId, source: 'genesys', subject: subject(r.group.queueId),
      kind: 'queue-backlog', value: waiting, unit: 'count', sampleSize: 1,
      window: { from: to, to }, severity: severityFor(waiting, COMMS_THRESHOLDS.queueBacklog),
      detail: waiting + ' callers waiting in ' + (names.get(r.group.queueId) ?? r.group.queueId),
    }));
  }

  const agg = await post<{ results: AggregateResult[] }>('/api/v2/analytics/conversations/aggregates/query',
    { interval: from + '/' + to, groupBy: ['queueId'], filter, metrics: ['nOffered', 'tAbandon'] });
  const t = COMMS_THRESHOLDS.queueAbandonment;
  for (const r of agg.results) {
    const metrics = r.data.flatMap((d) => d.metrics);
    const sum = (name: string) => metrics.filter((m) => m.metric === name).reduce((a, m) => a + (m.stats.count ?? 0), 0);
    // `tAbandon` is ABSENT, not zero, when nobody abandoned. `?? 0` above is
    // what stops that reading as "no data".
    const offered = sum('nOffered');
    const abandoned = sum('tAbandon');
    if (offered < t.minSamples) continue;
    const rate = abandoned / offered;
    out.push(signal({
      tenantId: client.tenantId, source: 'genesys', subject: subject(r.group.queueId),
      kind: 'queue-abandonment', value: rate, unit: 'ratio', sampleSize: offered,
      window: { from, to }, severity: severityFor(rate, t),
      detail: abandoned + ' of ' + offered + ' callers abandoned ' + (names.get(r.group.queueId) ?? r.group.queueId),
    }));
  }
  return out.sort((a, b) => (a.subject.name + a.kind).localeCompare(b.subject.name + b.kind));
}

// ---------------------------------------------------------------------------

/** Every signal for the window ending at `at`, from every source the tenant runs. */
export async function collectSignals(
  client: CommsClient, config: CommsTenantConfig, workforce: WorkforceReport, at: number,
): Promise<CommsSignal[]> {
  const w: Window = { from: at - SIGNAL_WINDOW_MS, to: at };
  const members = new Map(workforce.members.map((m) => [m.emailKey, m]));
  const out: CommsSignal[] = [];
  if (config.sources.includes('teams')) {
    out.push(...await teamsTrunkSignals(client, w));
    out.push(...await teamsMediaSignals(client, w, members));
  }
  if (config.sources.includes('webex')) out.push(...await webexMediaSignals(client, w, members));
  if (config.sources.includes('genesys')) out.push(...await genesysQueueSignals(client, w));
  return out;
}
