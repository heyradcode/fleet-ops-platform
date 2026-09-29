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
import type { SignalSource } from './types.ts';
import type { IncidentContext } from './helix-context.ts';

export const SELF_EVIDENT: ReadonlySet<CommsSignalKind> = new Set<CommsSignalKind>([
  'trunk-call-failure', 'queue-backlog', 'queue-abandonment',
  // The dish measuring its own link: the system of record, like a trunk.
  'wan-latency', 'wan-drop-rate',
  // The call control counting its own registrations. What it INFERS about a
  // building's network is the knowledge graph's job, as a candidate.
  'desk-phone-registration',
]);

/** Which sources can witness each kind - so a missing witness can be named. */
export const WITNESSES: Record<CommsSignalKind, SignalSource[]> = {
  'trunk-call-failure': ['teams', 'bandwidth'],
  'facility-media-degradation': ['teams', 'webex'],
  'queue-backlog': ['genesys'],
  'queue-abandonment': ['genesys'],
  'wan-latency': ['starlink'],
  'wan-drop-rate': ['starlink'],
  'desk-phone-registration': ['cucm'],
};

export type CommsAlarm = {
  tenantId: TenantId;
  alarmId: string;
  subject: CommsSubject;
  kind: CommsSignalKind;
  severity: Severity;
  /** Sources whose signal crossed a threshold. */
  sources: SignalSource[];
  /** Sources that measured the same subject with enough samples and saw nothing wrong. */
  dissent: SignalSource[];
  /**
   * Where the fault is, when two vantage points on the same thing say so -
   * e.g. which leg of a trunk. Undefined when there is only one view.
   */
  localisation?: string;
  signalIds: string[];
  raisedAt: string;
  /** Whether this alarm may open an incident, and if not, why not. */
  corroborated: boolean;
  heldBack?: string;
  evidence: string[];
  /** The measurements behind the evidence strings - for anything that needs a NUMBER, not a sentence. */
  figures: Figure[];
};

/**
 * One measurement, structured. Evidence strings are for people; a consumer
 * that needs "how many calls failed" reads this, never a regex over a
 * sentence someone may reword.
 */
export type Figure = {
  source: SignalSource;
  kind: CommsSignalKind;
  value: number;
  unit: 'ratio' | 'count' | 'ms';
  sampleSize: number;
};

export type CommsIncident = {
  tenantId: TenantId;
  incidentId: string;
  title: string;
  severity: Severity;
  subject: CommsSubject;
  alarmIds: string[];
  kinds: CommsSignalKind[];
  sources: SignalSource[];
  /** From the alarms that could say where the fault is. */
  localisation: string[];
  /** Candidate changes and existing tickets from Helix. Context, never evidence. */
  context?: IncidentContext;
  openedAt: string;
  evidence: string[];
  figures: Figure[];

  // --- Lifecycle - see lifecycle.ts. correlateAlarms sets the defaults; the
  // --- reconciliation is what carries them across polls.
  status: 'open' | 'resolved';
  /** The last poll that raised it. */
  lastSeenAt: string;
  /** Consecutive polls that MEASURED the subject healthy. Resolves at RESOLVE_AFTER_CLEAR_POLLS. */
  clearPolls: number;
  /** Times it came back within the reopen window after resolving. */
  reopenCount: number;
  /** The worst it has been, which the current severity may have eased from. */
  peakSeverity: Severity;
  resolvedAt?: string;
  /** Why it is where it is: "measured healthy 2/3", "not re-verified: webex unavailable". */
  lifecycleNote?: string;
};

const RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };
const worst = (s: Severity[]) => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok' as Severity);
const subjectKey = (s: CommsSubject) => s.kind + ':' + s.id;

/**
 * Signals -> alarms. One alarm per (subject, kind), across every source that saw it.
 *
 * `unavailable` names the sources that FAILED this poll. An inference that
 * lacks its second witness is held back either way - but "Webex was down, so
 * nobody could check" and "Webex has no data on this" are different facts,
 * and the reason says which.
 */
export function evaluateSignals(
  signals: CommsSignal[], opts: { unavailable?: SignalSource[] } = {},
): CommsAlarm[] {
  const unavailable = opts.unavailable ?? [];
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
    // A dissenting source DISPUTES an inference - facility call quality - but
    // not a count. A trunk failing 70% of Teams's calls is failing them even
    // if the carrier's end is fine; the carrier's view then says WHERE, which
    // is what `localise` is for, rather than whether.
    if (dissent.length > 0 && !SELF_EVIDENT.has(first.kind)) {
      corroborated = false;
      heldBack = 'disputed: ' + dissent.join(', ') + ' measured the same subject and saw nothing wrong';
    } else if (!SELF_EVIDENT.has(first.kind) && sources.length < 2) {
      corroborated = false;
      const down = WITNESSES[first.kind].filter((s) => !sources.includes(s) && unavailable.includes(s));
      heldBack = down.length > 0
        ? 'single source (' + sources[0] + '); ' + down.join(', ') + ' was UNAVAILABLE this poll, ' +
          'so corroboration could not be attempted'
        : 'single source (' + sources[0] + '); needs a second, independent service to agree';
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
      localisation: localise(first.kind, first.subject, sources, dissent),
      evidence: firing.map((s) => s.detail),
      figures: firing.map((s) => ({ source: s.source, kind: s.kind, value: s.value, unit: s.unit, sampleSize: s.sampleSize })),
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
      title: titleFor(subject, group.map((a) => a.kind)),
      severity: worst(group.map((a) => a.severity)),
      subject,
      alarmIds: group.map((a) => a.alarmId),
      kinds: [...new Set(group.map((a) => a.kind))].sort(),
      sources: [...new Set(group.flatMap((a) => a.sources))].sort(),
      localisation: group.map((a) => a.localisation).filter((l): l is string => !!l),
      openedAt,
      status: 'open',
      lastSeenAt: openedAt,
      clearPolls: 0,
      reopenCount: 0,
      peakSeverity: worst(group.map((a) => a.severity)),
      evidence: group.flatMap((a) => a.evidence),
      figures: group.flatMap((a) => a.figures),
    };
  }).sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.title.localeCompare(b.title));
}

/**
 * Which leg of a trunk the fault is on, from which end saw it.
 *
 * The SBC sits between two networks: Teams on one side, the carrier on the
 * other. Each source watches one side. That makes the combination diagnostic
 * in a way neither source is alone - and the three answers send three
 * different people to look.
 */
export function localise(
  kind: CommsSignalKind, subject: CommsSubject, firing: SignalSource[], ok: SignalSource[],
): string | undefined {
  if (kind !== 'trunk-call-failure') return undefined;
  const teams = firing.includes('teams');
  const carrier = firing.includes('bandwidth');
  if (teams && carrier) {
    return 'Both legs failing - Teams->SBC and carrier->SBC. The SBC itself, or its site, is the likely fault.';
  }
  if (teams && ok.includes('bandwidth')) {
    return 'Carrier leg healthy (Bandwidth). The fault is between Teams and the SBC: its Teams-facing ' +
      'interface, its TLS certificate, or Microsoft\'s side.';
  }
  if (carrier && ok.includes('teams')) {
    return 'Teams leg healthy. The fault is on the carrier leg: Bandwidth, or the SBC\'s carrier-facing interface.';
  }
  if (carrier && subject.id.startsWith('bandwidth-peer:')) {
    return 'Seen by the carrier only - no Teams trunk maps to this SIP peer.';
  }
  return undefined;
}

function titleFor(subject: CommsSubject, kinds: CommsSignalKind[]): string {
  const wan = kinds.some((k) => k === 'wan-latency' || k === 'wan-drop-rate');
  const media = kinds.includes('facility-media-degradation');
  switch (subject.kind) {
    case 'trunk': return 'SBC ' + subject.name + ' is failing calls';
    case 'facility': {
      // One incident when both happen at one facility - the WAN evidence is
      // then very likely the explanation for the call quality.
      const phones = kinds.includes('desk-phone-registration');
      const base = wan && media ? 'Call quality and satellite WAN degraded at ' + subject.name
        : wan ? 'Satellite WAN degraded at ' + subject.name
          : media ? 'Call quality degraded at ' + subject.name : undefined;
      if (!phones) return base ?? 'Call quality degraded at ' + subject.name;
      return base ? base + ', and desk phones dropping off' : 'Desk phones dropping off the call control at ' + subject.name;
    }
    case 'queue': return 'Queue "' + subject.name + '" is overwhelmed';
  }
}
