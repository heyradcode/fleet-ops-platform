/**
 * ---------------------------------------------------------------------------
 * What a building's problem reaches in the contact centre
 * ---------------------------------------------------------------------------
 * The reverse of a queue's staffing walk (correlate.ts), and a different kind
 * of answer: IMPACT, not cause. When Houston's calls go bad, the queues
 * Houston staffs feel it - agents who cannot hear callers take longer, and
 * the public waits. "Up to 29 people who make calls there" misses the people
 * calling IN; this is the line that does not.
 *
 * The same rules as the staffing walk, for the same reasons:
 *
 *   A SHARE IS OF ALL A QUEUE'S MEMBERS, placed or not. Twelve agents in
 *   Houston out of fifty is 24% of the queue, whatever the other thirty-eight
 *   are - most of them contractors no directory places.
 *
 *   ONLY A QUEUE THIS BUILDING STAFFS A FIFTH OF IS LISTED (QUEUE_MIN_SHARE),
 *   and the rest are counted. A building with two agents in each of nine
 *   queues does not bring nine queues down, and a list of nine would say it
 *   does.
 *
 *   COUNTS, NEVER WHO. The graph holds no people; the edge holds a number.
 *
 * Context never fails its caller: a graph read that fails costs that
 * incident its impact line, never the view or the brief - the Helix rule.
 */
import type { Principal } from '../platform/types.ts';
import type { CommsIncident } from '../integrations/comms/incidents.ts';
import { QUEUE_MIN_SHARE } from './correlate.ts';
import { graphNode, neighbours } from './store.ts';

export type QueueImpact = { queueId: string; queueName: string; agents: number; members: number };

export type FacilityImpact = {
  /** Queues this building staffs at least QUEUE_MIN_SHARE of, most-staffed first. */
  queues: QueueImpact[];
  /** Queues with some agents here, below that share. Counted, not listed. */
  smaller: number;
};

/** The contact-centre queues a building staffs. One Query, then one GetItem per queue. */
export async function queuesStaffedFrom(principal: Principal, facilityCode: string): Promise<FacilityImpact> {
  const edges = await neighbours(principal, { type: 'Facility', id: facilityCode }, { direction: 'in', rel: 'STAFFED_FROM' });
  const all = await Promise.all(edges.map(async (e): Promise<QueueImpact> => {
    const q = await graphNode(principal, e.node);
    return { queueId: e.node.id, queueName: q?.label ?? e.node.id, agents: e.props?.agents ?? 0, members: Number(q?.props.members ?? 0) };
  }));
  const big = all.filter((q) => q.members > 0 && q.agents / q.members >= QUEUE_MIN_SHARE);
  return {
    queues: big.sort((a, b) => b.agents / b.members - a.agents / a.members || a.queueName.localeCompare(b.queueName)),
    smaller: all.length - big.length,
  };
}

/**
 * Per FACILITY incident, the queues it reaches - keyed by incident id, the
 * shape `causes` uses. Trunks and queues are not buildings; they get nothing.
 */
export async function impactForIncidents(
  principal: Principal, incidents: CommsIncident[],
): Promise<Record<string, FacilityImpact>> {
  const out: Record<string, FacilityImpact> = {};
  await Promise.all(incidents.filter((i) => i.subject.kind === 'facility').map(async (i) => {
    try {
      const impact = await queuesStaffedFrom(principal, i.subject.id);
      if (impact.queues.length || impact.smaller) out[i.incidentId] = impact;
    } catch {
      // The Helix rule: context failing costs that incident its line, nothing else.
    }
  }));
  return out;
}

/** In words: "Eligibility - English (12 of its 50 agents)", and how many more. */
export function describeImpact(impact: FacilityImpact): string {
  const listed = impact.queues.map((q) => q.queueName + ' (' + q.agents + ' of its ' + q.members + ' agents)').join('; ');
  if (!listed) return impact.smaller + ' queue' + (impact.smaller === 1 ? '' : 's') + ', none a fifth staffed from here';
  return impact.smaller ? listed + '; and ' + impact.smaller + ' more with fewer agents here' : listed;
}
