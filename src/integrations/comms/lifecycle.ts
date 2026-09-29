/**
 * ---------------------------------------------------------------------------
 * The comms incident lifecycle: one problem, one incident, until it is fixed
 * ---------------------------------------------------------------------------
 * `correlateAlarms` answers "what is wrong in THIS window". Nothing answered
 * "is this the same problem as five minutes ago" - so every poll minted a new
 * incident for the same outage, and an hour of SBC2 failing was twelve
 * incidents. This file is the continuity.
 *
 * IDENTITY IS THE SUBJECT. One open incident per trunk / facility / queue.
 * A poll that still sees the problem refreshes it - severity, evidence,
 * sources, Helix context - and keeps its id and its opening time.
 *
 * RESOLUTION NEEDS A HEALTHY MEASUREMENT, NOT THE ABSENCE OF A BAD ONE. This
 * is the rule the rest serves. A dead SBC at 3am carries almost no calls,
 * falls below the minimum sample and produces NO signal - and "no alarm this
 * poll" would close its incident while it is still dead. So a poll counts
 * toward resolution only if every kind of problem in the incident was
 * MEASURED healthy: an `ok` signal, with its sample, on that subject.
 *
 * A poll can therefore be one of three things for an open incident:
 *
 *   still firing     reset the clear count (corroborated or not: Houston's
 *                    calls still bad while Webex is down is not a recovery)
 *   measured clear   count it; resolve after RESOLVE_AFTER_CLEAR_POLLS
 *   unknown          the witness was down, or too few samples: neither count
 *                    nor reset, and say why
 *
 * FLAPPING REOPENS, IT DOES NOT MULTIPLY. A subject that goes bad again
 * within REOPEN_WITHIN_MS of resolving reopens the SAME incident and bumps
 * its flap count. One trunk that bounces all afternoon is one incident with
 * a history, not a page every twenty minutes.
 */
import { sha256 } from '../../platform/crypto.ts';
import { mainTable } from '../../aws/dynamodb.ts';
import { pk } from '../../platform/tenancy.ts';
import type { Principal, Severity } from '../../platform/types.ts';
import type { CommsIncident } from './incidents.ts';
import type { CommsSignal, CommsSubject } from './signals.ts';
import type { SignalSource } from './types.ts';
import { WITNESSES } from './incidents.ts';

/** Three five-minute polls. One good poll mid-outage is common; three in a row is a recovery. */
export const RESOLVE_AFTER_CLEAR_POLLS = 3;
/** A subject going bad again within this of resolving reopens the same incident. */
export const REOPEN_WITHIN_MS = 30 * 60 * 1000;

const RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };
const subjectKey = (s: CommsSubject) => s.kind + ':' + s.id;

const incPk = (p: Principal) => pk(p, 'COMMSINC');
const openSk = (s: CommsSubject) => 'OPEN#' + subjectKey(s);
const lastResolvedSk = (s: CommsSubject) => 'LASTRESOLVED#' + subjectKey(s);
const historySk = (i: CommsIncident) => 'RESOLVED#' + i.resolvedAt + '#' + i.incidentId;

function read(item: Record<string, unknown> | undefined): CommsIncident | undefined {
  if (!item) return undefined;
  const { PK, SK, entity, ...rest } = item;
  return rest as unknown as CommsIncident;
}

type Verdict = { state: 'firing' | 'clear' | 'unknown'; why: string };

/** What this poll says about an open incident that the rules did NOT raise again. */
function verdictFor(
  incident: CommsIncident, signals: CommsSignal[], unavailable: SignalSource[], notMeasured: ReadonlySet<string>,
): Verdict {
  const on = signals.filter((s) => subjectKey(s.subject) === subjectKey(incident.subject));
  const missing: string[] = [];
  for (const kind of incident.kinds) {
    const mine = on.filter((s) => s.kind === kind);
    if (mine.some((s) => RANK[s.severity] >= RANK.warning)) {
      // Firing but not promoted: held back this poll. Not a recovery.
      return { state: 'firing', why: kind + ' still firing (not corroborated this poll)' };
    }
    if (!mine.some((s) => s.severity === 'ok')) {
      const down = WITNESSES[kind].filter((w) => unavailable.includes(w));
      missing.push(kind + (down.length ? ' - ' + down.join(', ') + ' unavailable'
        : notMeasured.has(subjectKey(incident.subject) + '|' + kind) ? ' - not asked this poll (request budget)'
          : ' - too few samples to measure'));
    }
  }
  if (missing.length > 0) return { state: 'unknown', why: 'not re-verified: ' + missing.join('; ') };
  return { state: 'clear', why: 'measured healthy' };
}

export type Reconciled = {
  /** Every incident open after this poll, worst first. */
  open: CommsIncident[];
  /** Incidents this poll resolved. */
  resolved: CommsIncident[];
  /** Incident ids this poll reopened (flapping). */
  reopened: string[];
};

/**
 * Fold this poll's freshly correlated incidents into the stored open set.
 * `fresh` is correlateAlarms' output (with Helix context attached).
 */
export async function reconcileIncidents(
  principal: Principal, at: number, fresh: CommsIncident[], signals: CommsSignal[], unavailable: SignalSource[],
  /** `subjectKey|kind` pairs a source deliberately did not ask about this poll. */
  notMeasured: ReadonlySet<string> = new Set(),
): Promise<Reconciled> {
  const nowIso = new Date(at).toISOString();
  const stored = (await mainTable.query({ pk: incPk(principal), skBeginsWith: 'OPEN#' }))
    .map((i) => read(i)!)
    .filter(Boolean);
  const openBySubject = new Map(stored.map((i) => [subjectKey(i.subject), i]));
  const freshSubjects = new Set(fresh.map((i) => subjectKey(i.subject)));
  const reopened: string[] = [];
  /** Sort keys to remove once everything this poll writes has landed. */
  const deleteAfter: string[] = [];
  const resolved: CommsIncident[] = [];
  const open: CommsIncident[] = [];

  // --- Seen this poll: continue, reopen, or open ---------------------------
  for (const f of fresh) {
    const key = subjectKey(f.subject);
    const prev = openBySubject.get(key);
    let base: CommsIncident | undefined = prev;

    if (!prev) {
      // Resolved recently? Then this is the same problem back - reopen it.
      const last = read(await mainTable.get(incPk(principal), lastResolvedSk(f.subject)));
      if (last?.resolvedAt && at - Date.parse(last.resolvedAt) <= REOPEN_WITHIN_MS) {
        base = { ...last, reopenCount: (last.reopenCount ?? 0) + 1 };
        reopened.push(last.incidentId);
        deleteAfter.push(historySk(last));
      }
      deleteAfter.push(lastResolvedSk(f.subject));
    }

    const incident: CommsIncident = {
      ...f,
      // Identity and history from the stored incident; everything else is
      // this poll's - the current severity, evidence and context.
      incidentId: base?.incidentId ?? 'cinc-' + sha256(principal.tenantId + '|' + key + '|' + nowIso).slice(0, 20),
      openedAt: base?.openedAt ?? nowIso,
      status: 'open',
      lastSeenAt: nowIso,
      clearPolls: 0,
      reopenCount: base?.reopenCount ?? 0,
      peakSeverity: RANK[f.severity] > RANK[base?.peakSeverity ?? 'ok'] ? f.severity : (base?.peakSeverity ?? f.severity),
      resolvedAt: undefined,
      lifecycleNote: base && prev ? undefined
        : base ? 'reopened - the same problem returned within ' + REOPEN_WITHIN_MS / 60_000 + ' min of resolving'
          : undefined,
    };
    open.push(incident);
  }

  // --- Not raised this poll: count toward resolution only if measured clear -
  for (const prev of stored) {
    if (freshSubjects.has(subjectKey(prev.subject))) continue;
    const v = verdictFor(prev, signals, unavailable, notMeasured);
    const clearPolls = v.state === 'clear' ? (prev.clearPolls ?? 0) + 1 : v.state === 'firing' ? 0 : (prev.clearPolls ?? 0);

    if (clearPolls >= RESOLVE_AFTER_CLEAR_POLLS) {
      const done: CommsIncident = {
        ...prev, status: 'resolved', resolvedAt: nowIso, clearPolls,
        lifecycleNote: 'resolved - measured healthy for ' + clearPolls + ' consecutive polls',
      };
      resolved.push(done);
      continue;
    }
    open.push({
      ...prev,
      clearPolls,
      lifecycleNote: v.state === 'clear'
        ? 'measured healthy ' + clearPolls + '/' + RESOLVE_AFTER_CLEAR_POLLS + ' - resolving if it holds'
        : v.why,
    });
  }

  // --- Persist: open set rewritten, resolved moved to history --------------
  // WRITE FIRST, DELETE LAST, and delete only what resolved. The open row's key
  // is the subject, so a put overwrites it in place; clearing the whole open
  // set first and re-writing it was harmless in memory and, against a real
  // table, a crash between the two would lose every open incident - the one
  // record of what is broken right now. The same goes for a reopen: its
  // history row is removed only after the incident is written back as open.
  // In this order a crash leaves at worst
  // a resolved incident still listed open for one more poll, which the next
  // poll resolves again. Sequential on purpose, not Promise.all: a delete
  // racing a put on the same key could land second.
  for (const i of open) await mainTable.put({ PK: incPk(principal), SK: openSk(i.subject), entity: 'CommsIncident', ...i });
  for (const i of resolved) {
    await mainTable.put({ PK: incPk(principal), SK: historySk(i), entity: 'CommsIncident', ...i });
    await mainTable.put({ PK: incPk(principal), SK: lastResolvedSk(i.subject), entity: 'CommsIncident', ...i });
  }
  const stillOpen = new Set(open.map((i) => openSk(i.subject)));
  for (const i of stored) {
    if (!stillOpen.has(openSk(i.subject))) deleteAfter.push(openSk(i.subject));
  }
  for (const sk of deleteAfter) await mainTable.delete(incPk(principal), sk);

  open.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.title.localeCompare(b.title));
  return { open, resolved, reopened };
}

export async function openCommsIncidents(principal: Principal): Promise<CommsIncident[]> {
  return (await mainTable.query({ pk: incPk(principal), skBeginsWith: 'OPEN#' }))
    .map((i) => read(i)!)
    .sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.title.localeCompare(b.title));
}

export async function resolvedCommsIncidents(principal: Principal, limit = 10): Promise<CommsIncident[]> {
  return (await mainTable.query({ pk: incPk(principal), skBeginsWith: 'RESOLVED#', scanIndexForward: false, limit }))
    .map((i) => read(i)!);
}
