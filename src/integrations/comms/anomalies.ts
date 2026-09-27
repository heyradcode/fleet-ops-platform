/**
 * ---------------------------------------------------------------------------
 * Anomaly explanation: unusual FOR THIS SUBJECT, AT THIS TIME OF WEEK
 * ---------------------------------------------------------------------------
 * Thresholds say "15% abandonment is bad". They cannot say that 12% is four
 * times what THIS queue does at 10am on a Tuesday - and that is the finding
 * worth having before anything pages. This file keeps a baseline per
 * (subject, metric, source, hour of the week) and reports the departures,
 * with the explanation attached: "12%, normally 3% (±1%) on Tuesdays 10:00,
 * from 8 weeks of history".
 *
 * ANOMALIES ARE NOT ALARMS. They never page, never open an incident, and are
 * never evidence for one. They are the brief's "unusual, not yet at alarm
 * level", the assistant's context, and "normally X" beside an incident.
 *
 * THE BASELINE IS RUNNING STATISTICS, not stored history: count, mean and
 * sum of squared deviations (Welford) per bucket. Storage is bounded by
 * subjects x metrics x 168 hours, whatever the call volume - the same
 * argument that keeps call records out of the operational store.
 *
 * IT NEVER LEARNS AN OUTAGE. A value that is anomalous, or on a subject with
 * an open incident, is not folded in. Skip that and a long outage slowly
 * teaches the baseline that the outage is normal, and the next one is
 * invisible.
 *
 * HOUR OF THE WEEK IN THE CUSTOMER'S ZONE, through `Intl`, never a fixed UTC
 * offset: a fixed offset shifts every bucket by an hour twice a year, and a
 * Monday-9am baseline quietly starts describing Monday 8am.
 *
 * VOLUME IS A METRIC. Every rate carries its sample size, so the number of
 * calls through a trunk gets a baseline too - and the SILENCE of a dead SBC,
 * outbound calls simply stopping, becomes something that can be noticed.
 * Low volume is an anomaly in the downward direction; rates only upward.
 *
 * TWO GUARDS ON EVERY VERDICT. Too little history (fewer than MIN_HISTORY
 * samples in that hour-of-week bucket) is "not enough history", not a
 * verdict. And a spread FLOOR plus a minimum absolute change per metric: a
 * queue with exactly zero callers waiting at 3am every week has a spread of
 * zero, and without a floor one caller would be infinitely unusual.
 */
import { mainTable } from '../../aws/dynamodb.ts';
import { pk } from '../../platform/tenancy.ts';
import type { Principal } from '../../platform/types.ts';
import type { CommsSignal, CommsSignalKind, CommsSubject } from './signals.ts';
import type { SignalSource } from './types.ts';

export type MetricName = CommsSignalKind | `${CommsSignalKind}:volume`;

/** One number, from one signal, at one time. */
export type MetricPoint = {
  subject: CommsSubject;
  metric: MetricName;
  source: SignalSource;
  value: number;
  unit: 'ratio' | 'count' | 'ms';
};

export type Baseline = { n: number; mean: number; m2: number };

export type CommsAnomaly = {
  subject: CommsSubject;
  metric: MetricName;
  source: SignalSource;
  value: number;
  unit: 'ratio' | 'count' | 'ms';
  normal: { mean: number; std: number; samples: number };
  /** Standard deviations from normal, using the floored spread. */
  z: number;
  direction: 'above' | 'below';
  /** "Tuesdays 10:00" in the customer's zone. */
  when: string;
  explanation: string;
};

/** Weeks of the same hour needed before a bucket gives verdicts. */
export const MIN_HISTORY = 4;
/** How far out, in (floored) standard deviations, counts as unusual. */
export const Z_THRESHOLD = 3;

type Guard = { stdFloor: (mean: number) => number; minDelta: (mean: number) => number; directions: Array<'above' | 'below'> };

/*
 * Counts - calls, callers waiting - are Poisson-ish, so their natural noise is
 * sqrt(mean). That is the spread FLOOR: eight weeks of history can easily
 * under-estimate it (a Legacy PBX trunk at 17 calls came out at ±2 and made
 * 25 calls look like z=4), and the floor is what stops noise reading as news.
 */
const poissonFloor = (m: number) => Math.max(1, Math.sqrt(Math.max(0, m)));
const RATE: Guard = { stdFloor: () => 0.01, minDelta: () => 0.03, directions: ['above'] };
const BACKLOG: Guard = { stdFloor: poissonFloor, minDelta: () => 3, directions: ['above'] };
const VOLUME: Guard = { stdFloor: poissonFloor, minDelta: (m) => Math.max(5, 0.3 * m), directions: ['above', 'below'] };

/** Latency: a floor of 5 ms of spread and 30 ms of change - jitter in a dish is not news. */
const LATENCY: Guard = { stdFloor: () => 5, minDelta: () => 30, directions: ['above'] };

function guardFor(metric: MetricName): Guard {
  if (metric.endsWith(':volume')) return VOLUME;
  if (metric === 'wan-latency') return LATENCY;
  return metric === 'queue-backlog' ? BACKLOG : RATE;
}

/**
 * The rates whose sample size is a number of CALLS, and so a volume worth a
 * baseline. A dish reports once a minute whatever happens; its sample count
 * is a clock, not traffic.
 */
const CALL_VOLUME_KINDS = new Set<CommsSignalKind>(['trunk-call-failure', 'queue-abandonment', 'facility-media-degradation']);

/** Signals -> the points worth a baseline: each value, and each rate's volume. */
export function metricsFromSignals(signals: CommsSignal[]): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (const s of signals) {
    out.push({ subject: s.subject, metric: s.kind, source: s.source, value: s.value, unit: s.unit });
    if (s.unit === 'ratio' && CALL_VOLUME_KINDS.has(s.kind)) {
      out.push({ subject: s.subject, metric: (s.kind + ':volume') as MetricName, source: s.source, value: s.sampleSize, unit: 'count' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Time of week
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Hour of the week (0-167, Sunday 00:00 = 0) in `timeZone`. DST-correct by construction. */
export function hourOfWeek(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(at));
  const day = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')!.value);
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  return day * 24 + hour;
}

export function describeHour(how: number): string {
  return WEEKDAYS[Math.floor(how / 24)] + 's ' + String(how % 24).padStart(2, '0') + ':00';
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const basePk = (p: Principal) => pk(p, 'BASELINE');
const key = (pt: { subject: CommsSubject; metric: MetricName; source: SignalSource }, how: number) =>
  pt.subject.kind + ':' + pt.subject.id + '|' + pt.metric + '|' + pt.source + '|' + how;

async function readBaseline(principal: Principal, k: string): Promise<Baseline | undefined> {
  const item = await mainTable.get(basePk(principal), k);
  return item ? { n: Number(item.n), mean: Number(item.mean), m2: Number(item.m2) } : undefined;
}

/** Welford's update: numerically stable, one pass, no history kept. */
function fold(b: Baseline | undefined, x: number): Baseline {
  const prev = b ?? { n: 0, mean: 0, m2: 0 };
  const n = prev.n + 1;
  const delta = x - prev.mean;
  const mean = prev.mean + delta / n;
  return { n, mean, m2: prev.m2 + delta * (x - mean) };
}

const stdOf = (b: Baseline) => (b.n > 1 ? Math.sqrt(b.m2 / (b.n - 1)) : 0);

// ---------------------------------------------------------------------------
// Detect, then learn
// ---------------------------------------------------------------------------

/** Volume metrics in the words a person would use. */
const VOLUME_LABEL: Partial<Record<MetricName, string>> = {
  'trunk-call-failure:volume': 'calls through',
  'queue-abandonment:volume': 'calls offered to',
  'facility-media-degradation:volume': 'calls measured at',
};

function explain(p: MetricPoint, normal: CommsAnomaly['normal'], direction: 'above' | 'below', when: string): string {
  const fmt = (v: number) => (p.unit === 'ratio' ? Math.round(v * 1000) / 10 + '%'
    : String(Math.round(v * 10) / 10) + (p.unit === 'ms' ? ' ms' : ''));
  const what = VOLUME_LABEL[p.metric] ?? p.metric.replace(/-/g, ' ');
  const factor = normal.mean > 0 ? ' - ' + (Math.round((p.value / normal.mean) * 10) / 10) + 'x normal' : '';
  const subject = VOLUME_LABEL[p.metric] ? what + ' ' + p.subject.name : what + ' on ' + p.subject.name;
  return subject + ' (' + p.source + ') is ' + fmt(p.value) + ', ' + direction +
    ' its normal ' + fmt(normal.mean) + ' (±' + fmt(normal.std) + ') for ' + when + ', from ' +
    normal.samples + ' weeks of history' + factor + '.';
}

/**
 * Compare this poll's points with their baselines, then fold the NORMAL ones
 * in. `learnExcept` names subjects with an open incident: their values are
 * not learned from, whatever they are.
 */
export async function detectAndLearn(
  principal: Principal, at: number, timeZone: string, points: MetricPoint[], learnExcept: Set<string>,
): Promise<{ anomalies: CommsAnomaly[]; learned: number; insufficient: number }> {
  const how = hourOfWeek(at, timeZone);
  const when = describeHour(how);
  const anomalies: CommsAnomaly[] = [];
  let learned = 0;
  let insufficient = 0;

  for (const p of points) {
    const k = key(p, how);
    const b = await readBaseline(principal, k);
    let anomalous = false;
    if (!b || b.n < MIN_HISTORY) {
      insufficient++;
    } else {
      const g = guardFor(p.metric);
      const std = Math.max(stdOf(b), g.stdFloor(b.mean));
      const z = (p.value - b.mean) / std;
      const direction = z >= 0 ? 'above' : 'below';
      if (Math.abs(z) >= Z_THRESHOLD && Math.abs(p.value - b.mean) >= g.minDelta(b.mean) && g.directions.includes(direction)) {
        anomalous = true;
        const normal = { mean: b.mean, std, samples: b.n };
        anomalies.push({
          subject: p.subject, metric: p.metric, source: p.source, value: p.value, unit: p.unit,
          normal, z: Math.round(z * 10) / 10, direction, when, explanation: explain(p, normal, direction, when),
        });
      }
    }
    const subjectKey = p.subject.kind + ':' + p.subject.id;
    if (!anomalous && !learnExcept.has(subjectKey)) {
      await mainTable.put({ PK: basePk(principal), SK: k, entity: 'Baseline', ...fold(b, p.value) });
      learned++;
    }
  }
  anomalies.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return { anomalies, learned, insufficient };
}

/** Learn without judging - for backfill, where the history is assumed normal. */
export async function learnOnly(principal: Principal, at: number, timeZone: string, points: MetricPoint[]): Promise<number> {
  const how = hourOfWeek(at, timeZone);
  // Read-fold-write, one point at a time: two points can share a key, and the
  // second must fold into the first's result, not race it from the old one.
  for (const p of points) {
    const k = key(p, how);
    await mainTable.put({ PK: basePk(principal), SK: k, entity: 'Baseline', ...fold(await readBaseline(principal, k), p.value) });
  }
  return points.length;
}

/**
 * Seed baselines from past windows: the same hour, `weeks` weeks running.
 *
 * `signalsAt` is injected. In production it is `collectSignals` over a past
 * window - Genesys analytics, Graph call records and Bandwidth Insights all
 * answer for past intervals. The offline mocks only serve RECENT activity,
 * so the demo and tests pass a version that moves the injected clock first;
 * that harness lives with them, not here.
 *
 * History is ASSUMED NORMAL. A backfill across a past outage would teach it
 * as normal - so in production, skip any week that had an incident on file.
 */
export async function backfillBaselines(
  principal: Principal, at: number, timeZone: string, weeks: number,
  signalsAt: (at: number) => Promise<CommsSignal[]>,
): Promise<number> {
  let points = 0;
  for (let w = weeks; w >= 1; w--) {
    const past = at - w * 7 * 24 * 60 * 60 * 1000;
    points += await learnOnly(principal, past, timeZone, metricsFromSignals(await signalsAt(past)));
  }
  return points;
}

/** The latest poll's anomalies, stored as one item: they describe NOW. */
export async function putAnomalies(principal: Principal, asOf: string, anomalies: CommsAnomaly[]): Promise<void> {
  await mainTable.put({ PK: pk(principal, 'COMMS'), SK: 'ANOMALIES#LATEST', entity: 'Anomalies', asOf, anomalies });
}

export async function latestAnomalies(principal: Principal): Promise<{ asOf: string; anomalies: CommsAnomaly[] } | undefined> {
  const item = await mainTable.get(pk(principal, 'COMMS'), 'ANOMALIES#LATEST');
  return item ? { asOf: String(item.asOf), anomalies: item.anomalies as CommsAnomaly[] } : undefined;
}
