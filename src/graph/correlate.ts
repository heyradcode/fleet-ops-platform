/**
 * Candidate causes: what the knowledge graph puts next to a comms incident.
 *
 * "Houston's call quality is degraded - why?" Each domain answers inside
 * itself; this walks from the incident's SUBJECT to the network that serves
 * it and asks what the network rules raised there, around that time.
 *
 *   facility   Facility <- LOCATED_AT <- Device      (the building's network)
 *   trunk      Sbc -> RUNS_ON -> switch -> UPLINKS_TO* -> core -> WAN edge
 *              (the SBC's own path out to the carrier - never a sibling)
 *   queue      Queue -> STAFFED_FROM -> Facility <- LOCATED_AT <- Device
 *              (the buildings that staff at least QUEUE_MIN_SHARE of it)
 *
 * A TRUNK'S PATH IS UP, THEN OUT. Carrier traffic leaves the SBC through its
 * switch, climbs the uplink chain to the site's core and leaves by the WAN
 * edge. Those devices can hurt the trunk; the access switch beside the SBC's
 * own shares a parent with it, not a path - the recentChanges rule, for the
 * same reason. Nearer on the path ranks higher.
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
 * The window is [opened - 15 min, now] for ALARMS: a WAN edge that started
 * dropping packets ten minutes before the calls went bad is the classic
 * shape, and one raised an hour earlier is history. A network INCIDENT that
 * is still OPEN counts whenever it opened - an outage that began an hour ago
 * and is still going is the likeliest cause there is - and a RESOLVED one
 * does not, because it is over.
 */
import type { Alarm, Incident, Principal, Severity } from '../platform/types.ts';
import type { CommsIncident } from '../integrations/comms/incidents.ts';
import { graphBuilt, graphNode, neighbours } from './store.ts';
import type { NodeRef } from './model.ts';

export const CAUSE_WINDOW_BEFORE_MS = 15 * 60_000;
/** More than this is a list nobody reads; the ranking decides who is on it. */
export const MAX_CAUSES = 5;
/** A trunk's uplink walk stops here: a loop in bad data must not walk forever. */
const MAX_CHAIN = 8;
/**
 * A building staffing less than this share of a queue - of ALL its members,
 * placed or not - is not where the queue's trouble is. Three agents of forty
 * in a building with a bad switch do not explain forty agents' backlog.
 */
export const QUEUE_MIN_SHARE = 0.2;

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

/**
 * Another comms incident OPEN where this one's reach goes - today, a facility
 * incident in a building that staffs a queue. Not a network cause and not
 * evidence: the same building's calls going bad beside a queue backing up is
 * one story, usually with one root, and a person should see both halves.
 */
export type RelatedIncident = { incidentId: string; title: string; severity: Severity; subjectId: string; path: string };

export type CandidateCauses =
  | { status: 'found'; causes: CandidateCause[]; related?: RelatedIncident[] }
  | { status: 'none'; searched: string; related?: RelatedIncident[] }
  | { status: 'no-path'; reason: string }
  | { status: 'unknown'; reason: string };

const RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };
const hhmm = (iso: string) => iso.slice(11, 16);

/** The devices a subject can see: hops from the subject, and the path there, device last. */
type Reach = {
  devices: Map<string, { hops: number; path: string }>;
  searched: string;
  /** The buildings on the way, and the path to each - where related comms incidents are looked for. */
  buildings?: Map<string, string>;
};
type NotReached = Exclude<CandidateCauses, { status: 'found' | 'none' }>;

const named = (label: string, role: unknown) => label + ' (' + String(role ?? 'device') + ')';

async function facilityReach(principal: Principal, id: string, subjectName: string): Promise<Reach | NotReached> {
  const facilityRef: NodeRef = { type: 'Facility', id };
  const facility = await graphNode(principal, facilityRef);
  if (!facility) {
    // Two different answers. No graph at all is "could not look"; a graph
    // without this facility - an unmapped satellite terminal, a code the
    // tenant tables do not name - is "nothing connects it".
    if (!(await graphBuilt(principal))) {
      return { status: 'unknown', reason: 'the knowledge graph has not been built for this tenant' };
    }
    return { status: 'no-path', reason: subjectName + ' is not a facility in the knowledge graph, so no network is recorded for it' };
  }
  // ONE Query: the building's network. Every device is one hop away, and its
  // name is only fetched if it makes the list (see the ranking below).
  const located = await neighbours(principal, facilityRef, { direction: 'in', rel: 'LOCATED_AT' });
  if (located.length === 0) return { status: 'no-path', reason: 'no network devices are recorded at ' + facility.label };
  const via = facility.label + ' (' + facility.id + ') <- LOCATED_AT <- ';
  return {
    devices: new Map(located.map((n) => [n.node.id, { hops: 1, path: via }])),
    searched: located.length + ' network device' + (located.length === 1 ? '' : 's') + ' at ' + facility.label,
  };
}

async function queueReach(principal: Principal, queueId: string, name: string): Promise<Reach | NotReached> {
  const ref: NodeRef = { type: 'Queue', id: queueId };
  const queue = await graphNode(principal, ref);
  if (!queue) {
    if (!(await graphBuilt(principal))) {
      return { status: 'unknown', reason: 'the knowledge graph has not been built for this tenant' };
    }
    return { status: 'no-path', reason: 'no staffing is recorded for the "' + name + '" queue' };
  }
  const members = Number(queue.props.members ?? 0);
  const unplaced = Number(queue.props.unplaced ?? 0);
  const staffed = await neighbours(principal, ref, { direction: 'out', rel: 'STAFFED_FROM' });
  const main = staffed.filter((n) => members > 0 && (n.props?.agents ?? 0) / members >= QUEUE_MIN_SHARE);
  const cannot = unplaced ? unplaced + ' of its ' + members + ' agents cannot be placed in any building' : '';
  if (main.length === 0) {
    return {
      status: 'no-path',
      reason: 'no building staffs a fifth of the "' + name + '" queue - its placed agents are spread over ' +
        staffed.length + ' building' + (staffed.length === 1 ? '' : 's') + (cannot ? '; ' + cannot : ''),
    };
  }
  const devices = new Map<string, { hops: number; path: string }>();
  const buildings = new Map<string, string>();
  const staffing: string[] = [];
  for (const f of main) {
    const node = await graphNode(principal, f.node);
    const label = node?.label ?? f.node.id;
    const agents = f.props?.agents ?? 0;
    staffing.push(label + ' ' + agents + ' of ' + members);
    const toBuilding = 'Queue "' + name + '" -> STAFFED_FROM (' + agents + ' of ' + members + ' agents) -> ' + label + ' (' + f.node.id + ')';
    buildings.set(f.node.id, toBuilding);
    const via = toBuilding + ' <- LOCATED_AT <- ';
    for (const d of await neighbours(principal, f.node, { direction: 'in', rel: 'LOCATED_AT' })) {
      devices.set(d.node.id, { hops: 2, path: via });
    }
  }
  if (devices.size === 0) return { status: 'no-path', reason: 'no network devices are recorded in the buildings that staff "' + name + '"' };
  return {
    devices, buildings,
    searched: devices.size + ' network device' + (devices.size === 1 ? '' : 's') + ' in the buildings that staff "' + name + '" (' +
      staffing.join(', ') + (cannot ? '; ' + cannot : '') + ')',
  };
}

async function trunkReach(principal: Principal, fqdn: string): Promise<Reach | NotReached> {
  const sbc: NodeRef = { type: 'Sbc', id: fqdn };
  if (!(await graphNode(principal, sbc))) {
    if (!(await graphBuilt(principal))) {
      return { status: 'unknown', reason: 'the knowledge graph has not been built for this tenant' };
    }
    return { status: 'no-path', reason: fqdn + ' is not an SBC in the knowledge graph' };
  }
  const plugged = await neighbours(principal, sbc, { direction: 'out', rel: 'RUNS_ON' });
  if (plugged.length === 0) {
    return { status: 'no-path', reason: 'no source says which network device ' + fqdn + ' sits behind, so the graph stops at the SBC' };
  }

  // UP: the switch, then each uplink to the top of the tree.
  const devices = new Map<string, { hops: number; path: string }>();
  let via = 'SBC ' + fqdn + ' -> RUNS_ON -> ';
  let current: NodeRef | undefined = plugged[0].node;
  let top: { ref: NodeRef; label: string; hops: number; via: string } | undefined;
  for (let hops = 1; current && hops <= MAX_CHAIN && !devices.has(current.id); hops++) {
    const node = await graphNode(principal, current);
    devices.set(current.id, { hops, path: via });
    top = { ref: current, label: named(node?.label ?? current.id, node?.props.role), hops, via };
    via = via + top.label + ' -> UPLINKS_TO -> ';
    current = (await neighbours(principal, current, { direction: 'out', rel: 'UPLINKS_TO' }))[0]?.node;
  }

  // OUT: the WAN edge that hangs off the top - where carrier traffic leaves.
  // Only a wan-edge: the top's other children are other branches, not the path.
  if (top) {
    for (const child of await neighbours(principal, top.ref, { direction: 'in', rel: 'UPLINKS_TO' })) {
      const node = await graphNode(principal, child.node);
      if (node?.props.role === 'wan-edge' && !devices.has(child.node.id)) {
        devices.set(child.node.id, { hops: top.hops + 1, path: top.via + top.label + ' -> out through ' });
      }
    }
  }
  return {
    devices,
    searched: devices.size + ' network device' + (devices.size === 1 ? '' : 's') + ' on the path of ' + fqdn + ' (its switch, up to the core, out through the WAN edge)',
  };
}

export async function candidateCauses(
  principal: Principal,
  incident: CommsIncident,
  network: NetworkDecisions,
  nowIso: string,
  /** The other OPEN comms incidents, for `related`. */
  peers: CommsIncident[] = [],
): Promise<CandidateCauses> {
  const subject = incident.subject;
  const reach = subject.kind === 'trunk' ? await trunkReach(principal, subject.id)
    : subject.kind === 'queue' ? await queueReach(principal, subject.id, subject.name)
      : await facilityReach(principal, subject.id, subject.name);
  if ('status' in reach) return reach;

  const related: RelatedIncident[] = peers
    .filter((p) => p.incidentId !== incident.incidentId && p.status === 'open' &&
      p.subject.kind === 'facility' && reach.buildings?.has(p.subject.id))
    .sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.incidentId.localeCompare(b.incidentId))
    .map((p) => ({ incidentId: p.incidentId, title: p.title, severity: p.severity, subjectId: p.subject.id, path: reach.buildings!.get(p.subject.id)! }));
  const withRelated = related.length ? { related } : {};

  const reached = reach.devices;
  const from = new Date(Date.parse(incident.openedAt) - CAUSE_WINDOW_BEFORE_MS).toISOString();
  const searched = reach.searched + ', ' + hhmm(from) + 'Z to ' + hhmm(nowIso) + 'Z';

  const inWindow = (at: string) => at >= from && at <= nowIso;
  const minutesBefore = (at: string) => Math.round((Date.parse(incident.openedAt) - Date.parse(at)) / 60_000);

  type Hit = Omit<CandidateCause, 'device' | 'role' | 'path'> & { hops: number };
  const hits: Hit[] = [];

  // A network incident first: it already names its own cause. Its alarms are
  // then not listed again one by one.
  const covered = new Set<string>();
  for (const inc of network.incidents) {
    // Open: whenever it opened. Resolved: over - see the header.
    if (inc.status === 'resolved' || inc.openedAt > nowIso) continue;
    const here = inc.deviceIds.filter((d) => reached.has(d));
    if (here.length === 0) continue;
    for (const a of inc.alarmIds) covered.add(a);
    const deviceId = inc.rootCauseDeviceId && reached.has(inc.rootCauseDeviceId) ? inc.rootCauseDeviceId : here[0];
    hits.push({
      kind: 'network-incident', id: inc.incidentId, deviceId, hops: reached.get(deviceId)!.hops,
      what: inc.title, severity: inc.severity, at: inc.openedAt, minutesBefore: minutesBefore(inc.openedAt), paged: true,
    });
  }

  const held = new Set(network.heldBack.map((a) => a.alarmId));
  const alarms = new Map<string, Alarm>();
  for (const a of [...network.alarms, ...network.heldBack]) alarms.set(a.alarmId, a);
  for (const a of alarms.values()) {
    if (covered.has(a.alarmId) || !reached.has(a.deviceId) || !inWindow(a.raisedAt)) continue;
    hits.push({
      kind: 'network-alarm', id: a.alarmId, deviceId: a.deviceId, hops: reached.get(a.deviceId)!.hops,
      what: KIND_LABEL[a.kind] ?? a.kind, severity: a.severity, at: a.raisedAt,
      minutesBefore: minutesBefore(a.raisedAt), paged: !held.has(a.alarmId),
    });
  }

  if (hits.length === 0) return { status: 'none', searched, ...withRelated };

  // Worst first; then what paged over what did not; then nearer on the path;
  // then nearest in time.
  hits.sort((x, y) =>
    RANK[y.severity] - RANK[x.severity]
    || Number(y.paged) - Number(x.paged)
    || x.hops - y.hops
    || Math.abs(x.minutesBefore) - Math.abs(y.minutesBefore)
    || x.id.localeCompare(y.id));
  const top = hits.slice(0, MAX_CAUSES);

  // Names and roles for the few that made the list - one GetItem each.
  const causes = await Promise.all(top.map(async ({ hops: _hops, ...h }): Promise<CandidateCause> => {
    const node = await graphNode(principal, { type: 'Device', id: h.deviceId });
    const device = node?.label ?? h.deviceId;
    const role = String(node?.props.role ?? 'device');
    return { ...h, device, role, path: reached.get(h.deviceId)!.path + named(device, role) };
  }));
  return { status: 'found', causes, ...withRelated };
}

/**
 * Candidate causes for each of a set of incidents, keyed by incident id - in
 * parallel, since each is reads only. What the board shows and what the
 * brief is handed are the same call, so they cannot disagree.
 */
export async function causesForIncidents(
  principal: Principal, incidents: CommsIncident[], network: NetworkDecisions, nowIso: string,
  /** Every OPEN comms incident, when `incidents` is only some of them. */
  peers: CommsIncident[] = incidents,
): Promise<Record<string, CandidateCauses>> {
  return Object.fromEntries(await Promise.all(incidents.map(async (i) => {
    try {
      return [i.incidentId, await candidateCauses(principal, i, network, nowIso, peers)] as const;
    } catch (err) {
      // Context, and context failing never fails its caller - the Helix
      // rule. One throttled read must not blank the comms view and the brief.
      const reason = 'the knowledge graph could not be read (' + (err instanceof Error ? err.message : String(err)) + ')';
      return [i.incidentId, { status: 'unknown', reason } satisfies CandidateCauses] as const;
    }
  })));
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
