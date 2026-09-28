/**
 * Candidate causes: what the knowledge graph puts next to a comms incident.
 *
 * "Houston's call quality is degraded - why?" Each domain answers inside
 * itself; this walks from the incident's SUBJECT to the network that serves
 * it and asks what the network rules raised there, around that time.
 *
 *   facility   Facility <- LOCATED_AT <- Device      (the building's network)
 *   trunk      Sbc -> RUNS_ON -> Device               NOT KNOWN: no source yet
 *   queue      -                                     a queue is not a place
 *
 * CANDIDATES, NEVER EVIDENCE - the Helix rule, and for the same reason. This
 * runs AFTER both sets of rules have decided, reads their decisions, and
 * changes none of them: a held-back network alarm stays held back, a comms
 * incident keeps its severity, nothing is promoted, merged or suppressed. It
 * only says "look here too", and names the path it followed so a human can
 * judge whether the building really is the link.
 *
 * FOUR ANSWERS, not two, because "found nothing" and "could not look" must
 * never look alike (the comms health rule):
 *   found     candidates, ranked, each with its path
 *   none      it looked - and says what it searched, so "none" is checkable
 *   no-path   nothing in the graph connects this subject to the network
 *   unknown   the graph itself is not there (not built for this tenant yet)
 *
 * The window is [opened - 15 min, now]: a WAN edge that started dropping
 * packets ten minutes before the calls went bad is the classic shape, and one
 * that recovered an hour earlier is history, not a candidate.
 */
import type { Alarm, Incident, Principal, Severity } from '../platform/types.ts';
import type { CommsIncident } from '../integrations/comms/incidents.ts';
import { graphNode, neighbours } from './store.ts';
import type { NodeRef } from './model.ts';

export const CAUSE_WINDOW_BEFORE_MS = 15 * 60_000;
/** More than this is a list nobody reads; the ranking decides who is on it. */
export const MAX_CAUSES = 5;

/** What the network rules decided - tenantScenarios() offline, the same shape deployed. */
export type NetworkDecisions = { alarms: Alarm[]; incidents: Incident[]; heldBack: Alarm[] };

export type CandidateCause = {
  kind: 'network-incident' | 'network-alarm';
  /** The incident or alarm id, as the network board shows it. */
  id: string;
  deviceId: string;
  device: string;
  role: string;
  what: string;
  severity: Severity;
  at: string;
  /** Positive: before the comms incident opened. Negative: after. */
  minutesBefore: number;
  /** A network incident paged someone; a held-back alarm did not (one witness). */
  paged: boolean;
  /** How the graph got from the subject to this device, as a reader would say it. */
  path: string;
};

export type CandidateCauses =
  | { status: 'found'; causes: CandidateCause[] }
  | { status: 'none'; searched: string }
  | { status: 'no-path'; reason: string }
  | { status: 'unknown'; reason: string };

const RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };
const hhmm = (iso: string) => iso.slice(11, 16);

export async function candidateCauses(
  principal: Principal,
  incident: CommsIncident,
  network: NetworkDecisions,
  nowIso: string,
): Promise<CandidateCauses> {
  const subject = incident.subject;
  if (subject.kind === 'queue') {
    return { status: 'no-path', reason: 'a contact-centre queue is not a place on the network' };
  }
  if (subject.kind === 'trunk') {
    return {
      status: 'no-path',
      reason: 'no source says which network device ' + subject.id + ' sits behind, so the graph stops at the SBC',
    };
  }

  const facilityRef: NodeRef = { type: 'Facility', id: subject.id };
  const facility = await graphNode(principal, facilityRef);
  if (!facility) {
    return { status: 'unknown', reason: 'the knowledge graph has no facility ' + subject.id + ' - it has not been built for this tenant' };
  }

  // ONE Query: the building's network.
  const located = await neighbours(principal, facilityRef, { direction: 'in', rel: 'LOCATED_AT' });
  const reached = new Set(located.map((n) => n.node.id));
  const from = new Date(Date.parse(incident.openedAt) - CAUSE_WINDOW_BEFORE_MS).toISOString();
  const searched = String(reached.size) + ' network device' + (reached.size === 1 ? '' : 's') +
    ' at ' + facility.label + ', ' + hhmm(from) + 'Z to ' + hhmm(nowIso) + 'Z';
  if (reached.size === 0) return { status: 'none', searched };

  const inWindow = (at: string) => at >= from && at <= nowIso;
  const minutesBefore = (at: string) => Math.round((Date.parse(incident.openedAt) - Date.parse(at)) / 60_000);

  type Hit = Omit<CandidateCause, 'device' | 'role' | 'path'>;
  const hits: Hit[] = [];

  // A network incident first: it already names its own cause. Its alarms are
  // then not listed again one by one.
  const covered = new Set<string>();
  for (const inc of network.incidents) {
    if (!inWindow(inc.openedAt)) continue;
    const here = inc.deviceIds.filter((d) => reached.has(d));
    if (here.length === 0) continue;
    for (const a of inc.alarmIds) covered.add(a);
    hits.push({
      kind: 'network-incident', id: inc.incidentId,
      deviceId: inc.rootCauseDeviceId && reached.has(inc.rootCauseDeviceId) ? inc.rootCauseDeviceId : here[0],
      what: inc.title, severity: inc.severity, at: inc.openedAt, minutesBefore: minutesBefore(inc.openedAt), paged: true,
    });
  }

  const held = new Set(network.heldBack.map((a) => a.alarmId));
  const alarms = new Map<string, Alarm>();
  for (const a of [...network.alarms, ...network.heldBack]) alarms.set(a.alarmId, a);
  for (const a of alarms.values()) {
    if (covered.has(a.alarmId) || !reached.has(a.deviceId) || !inWindow(a.raisedAt)) continue;
    hits.push({
      kind: 'network-alarm', id: a.alarmId, deviceId: a.deviceId,
      what: KIND_LABEL[a.kind] ?? a.kind, severity: a.severity, at: a.raisedAt,
      minutesBefore: minutesBefore(a.raisedAt), paged: !held.has(a.alarmId),
    });
  }

  if (hits.length === 0) return { status: 'none', searched };

  // Worst first; then what paged over what did not; then nearest in time.
  hits.sort((x, y) =>
    RANK[y.severity] - RANK[x.severity]
    || Number(y.paged) - Number(x.paged)
    || Math.abs(x.minutesBefore) - Math.abs(y.minutesBefore)
    || x.id.localeCompare(y.id));
  const top = hits.slice(0, MAX_CAUSES);

  // Names and roles for the few that made the list - one GetItem each.
  const causes = await Promise.all(top.map(async (h): Promise<CandidateCause> => {
    const node = await graphNode(principal, { type: 'Device', id: h.deviceId });
    const device = node?.label ?? h.deviceId;
    const role = String(node?.props.role ?? 'device');
    return { ...h, device, role, path: facility.label + ' (' + facility.id + ') <- LOCATED_AT <- ' + device + ' (' + role + ')' };
  }));
  return { status: 'found', causes };
}

const KIND_LABEL: Partial<Record<Alarm['kind'], string>> = {
  'link-down': 'Link down',
  'device-unreachable': 'Device unreachable',
  'adjacency-lost': 'Routing adjacency lost',
  'interface-errors': 'Interface errors',
  'capacity-saturation': 'Capacity saturation',
  'optical-degradation': 'Optical degradation',
  'power-fault': 'Power fault',
};
