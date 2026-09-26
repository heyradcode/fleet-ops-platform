/**
 * ---------------------------------------------------------------------------
 * Comms signals -> alarms -> incidents
 * ---------------------------------------------------------------------------
 * The same shape as the network pipeline's evaluate -> corroborate ->
 * correlate, with the rules restated for subjects that are not devices.
 *
 * CORROBORATION MEANS TWO INDEPENDENT SERVICES, for the same reason it means
 * two planes on the network side. "Call quality is bad at Houston" is an
 * INFERENCE about a site's network, drawn from clients' measurements, and one
 * source can be wrong about it on its own: a bad Teams client build, a Webex
 * media region having a bad hour, a codec regression. When Teams AND Webex -
 * different vendors, different clients, different media paths - both see
 * Houston degrade, the thing they share is the building's network. That is
 * the independence that counts.
 *
 * SELF-EVIDENT KINDS ARE EXEMPT, the comms version of `power-fault`. A trunk's
 * failure rate is the platform counting its own calls; a queue's backlog is
 * Genesys counting its own callers. Those are measurements by the system of
 * record, not opinions, and no second witness exists to ask.
 *
 * A DISSENTING SOURCE IS REPORTED, not outvoted. If Teams says Houston is bad
 * and Webex, with enough samples of its own, says Houston is fine, the alarm
 * is held back AND marked disputed - that disagreement is usually the most
 * useful thing on the board, because it points at the client, not the site.
 *
 * INCIDENTS GROUP BY SUBJECT and never across subjects. A failing SBC may well
 * be why a queue is abandoning, but nothing here knows which trunk a Genesys
 * queue's calls arrive on, and a merge by guesswork is how an unrelated
 * outage gets closed with the wrong root cause. That link belongs in the
 * knowledge graph once the SIP trunk inventory exists.
 */
import { sha256 } from '../../platform/crypto.ts';
import type { Severity, TenantId } from '../../platform/types.ts';
import type { CommsSignal, CommsSignalKind, CommsSubject } from './signals.ts';
import type { CommsSource } from './types.ts';

export const SELF_EVIDENT: ReadonlySet<CommsSignalKind> = new Set<CommsSignalKind>([
  'trunk-call-failure', 'queue-backlog', 'queue-abandonment',
]);

export type CommsAlarm = {
  tenantId: TenantId;
  alarmId: string;
  subject: CommsSubject;
  kind: CommsSignalKind;
  severity: Severity;
  /** Sources whose signal crossed a threshold. */
  sources: CommsSource[];
  /** Sources that measured the same subject with enough samples and saw nothing wrong. */
  dissent: CommsSource[];
  signalIds: string[];
  raisedAt: string;
  /** Whether this alarm may open an incident, and if not, why not. */
  corroborated: boolean;
  heldBack?: string;
  evidence: string[];
};

export type CommsIncident = {
  tenantId: TenantId;
  incidentId: string;
  title: string;
  severity: Severity;
  subject: CommsSubject;
  alarmIds: string[];
  kinds: CommsSignalKind[];
  sources: CommsSource[];
  openedAt: string;
  evidence: string[];
};

const RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };
const worst = (s: Severity[]) => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok' as Severity);
const subjectKey = (s: CommsSubject) => s.kind + ':' + s.id;

/** Signals -> alarms. One alarm per (subject, kind), across every source that saw it. */
export function evaluateSignals(signals: CommsSignal[]): CommsAlarm[] {
  const groups = new Map<string, CommsSignal[]>();
  for (const s of signals) {
    const k = subjectKey(s.subject) + '|' + s.kind;
    const list = groups.get(k);
    if (list) list.push(s); else groups.set(k, [s]);
  }

  const alarms: CommsAlarm[] = [];
  for (const group of groups.values()) {
    const firing = group.filter((s) => RANK[s.severity] >= RANK.warning);
    if (firing.length === 0) continue;
    const first = firing[0];
    const sources = [...new Set(firing.map((s) => s.source))].sort();
    const dissent = [...new Set(group.filter((s) => s.severity === 'ok').map((s) => s.source))]
      .filter((src) => !sources.includes(src)).sort();

    let corroborated = true;
    let heldBack: string | undefined;
    if (dissent.length > 0) {
      corroborated = false;
      heldBack = 'disputed: ' + dissent.join(', ') + ' measured the same subject and saw nothing wrong';
    } else if (!SELF_EVIDENT.has(first.kind) && sources.length < 2) {
      corroborated = false;
      heldBack = 'single source (' + sources[0] + '); needs a second, independent service to agree';
    }

    const window = firing.map((s) => s.window.to).sort()[firing.length - 1];
    alarms.push({
      tenantId: first.tenantId,
      alarmId: 'calm-' + sha256([first.tenantId, subjectKey(first.subject), first.kind, window].join('|')).slice(0, 20),
      subject: first.subject,
      kind: first.kind,
      severity: worst(firing.map((s) => s.severity)),
      sources,
      dissent,
      signalIds: firing.map((s) => s.signalId),
      raisedAt: window,
      corroborated,
      heldBack,
      evidence: firing.map((s) => s.detail),
    });
  }
  return alarms.sort((a, b) =>
    RANK[b.severity] - RANK[a.severity] || subjectKey(a.subject).localeCompare(subjectKey(b.subject)) || a.kind.localeCompare(b.kind));
}

/** Corroborated alarms -> incidents, one per subject. */
export function correlateAlarms(alarms: CommsAlarm[]): CommsIncident[] {
  const bySubject = new Map<string, CommsAlarm[]>();
  for (const a of alarms.filter((x) => x.corroborated)) {
    const k = subjectKey(a.subject);
    const list = bySubject.get(k);
    if (list) list.push(a); else bySubject.set(k, [a]);
  }

  return [...bySubject.values()].map((group): CommsIncident => {
    const subject = group[0].subject;
    const openedAt = group.map((a) => a.raisedAt).sort()[0];
    return {
      tenantId: group[0].tenantId,
      incidentId: 'cinc-' + sha256([group[0].tenantId, subjectKey(subject), openedAt].join('|')).slice(0, 20),
      title: titleFor(subject),
      severity: worst(group.map((a) => a.severity)),
      subject,
      alarmIds: group.map((a) => a.alarmId),
      kinds: [...new Set(group.map((a) => a.kind))].sort(),
      sources: [...new Set(group.flatMap((a) => a.sources))].sort(),
      openedAt,
      evidence: group.flatMap((a) => a.evidence),
    };
  }).sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.title.localeCompare(b.title));
}

function titleFor(subject: CommsSubject): string {
  switch (subject.kind) {
    case 'trunk': return 'SBC ' + subject.name + ' is failing calls';
    case 'facility': return 'Call quality degraded at ' + subject.name;
    case 'queue': return 'Queue "' + subject.name + '" is overwhelmed';
  }
}
