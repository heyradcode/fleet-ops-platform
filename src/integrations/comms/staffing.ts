/**
 * ---------------------------------------------------------------------------
 * Queue staffing: which buildings a contact-centre queue's agents sit in
 * ---------------------------------------------------------------------------
 * What turns "the Eligibility queue is overwhelmed" into something the
 * knowledge graph can follow: a queue is not a place, but its agents are in
 * places. COUNTS, per queue per building - nothing else leaves this file.
 *
 * Genesys lists a queue's MEMBERS (`GET /api/v2/routing/queues/{id}/members`,
 * pageSize at most 100, permission `routing:queue:view`; the older `/users`
 * form is deprecated) - by user id, from the platform's published API. It
 * holds nothing about buildings. The workforce join does (Entra or Webex, by
 * email), so each member is looked up by Genesys user id in THIS poll's
 * roster, in memory - the roster that is never stored.
 *
 * WHAT IS EASY TO GET WRONG:
 *
 *   A SHARE OF THE PLACED IS NOT A SHARE OF THE QUEUE. A contractor is not in
 *   the directory and Genesys holds no building, so they cannot be placed -
 *   and in a contact centre they can be most of the queue. Every share here
 *   is of ALL members; the unplaced are counted, never dropped. Five placed
 *   agents in Houston out of five placed is "all of them"; out of forty-three
 *   members it is twelve per cent.
 *
 *   MEMBERSHIP, NOT WHO IS ON SHIFT. `joined` flips as agents come and go
 *   through the day. The graph is STRUCTURE; who is taking calls right now is
 *   state, and belongs to the queue's own metrics.
 *
 *   IT CHANGES SLOWLY, SO IT IS READ SLOWLY. One request per queue (more past
 *   100 members) every five minutes would be the poll's heaviest read for its
 *   least-changing data. Refreshed at most every STAFFING_REFRESH_MS.
 *
 *   NAMES ARE IN EVERY ROW. A member carries `name` and `user.name`. Only the
 *   id is read.
 */
import type { CommsClient } from './client.ts';
import { drainGenesys } from './client.ts';
import type { WorkforceReport } from './workforce.ts';

export const STAFFING_REFRESH_MS = 60 * 60 * 1000;

export type QueueStaffing = {
  queueId: string;
  queueName: string;
  /** Every member, placed or not - the denominator of every share. */
  members: number;
  /** Members placed in each building, sorted by code. */
  byFacility: Array<{ code: string; agents: number }>;
  /** Members no source can place: a contractor, or an employee with no facility. */
  unplaced: number;
  /** The member listing hit the page ceiling: counts are LOW. */
  truncated: boolean;
};

export type StaffingSnapshot = { asOf: string; queues: QueueStaffing[] };

type QueueRow = { id: string; name: string };
/** The id is all that is read. `name` and `user.name` are in every row; see the header. */
type MemberRow = { id: string; user?: { id?: string } };

/** Pure. One queue's members -> counts, through the roster's Genesys ids. */
export function staffingOf(
  queue: QueueRow, memberIds: string[], facilityByGenesysId: ReadonlyMap<string, string | undefined>, truncated: boolean,
): QueueStaffing {
  const ids = [...new Set(memberIds)];
  const by = new Map<string, number>();
  let unplaced = 0;
  for (const id of ids) {
    const code = facilityByGenesysId.get(id);
    if (code) by.set(code, (by.get(code) ?? 0) + 1); else unplaced++;
  }
  return {
    queueId: queue.id, queueName: queue.name, members: ids.length,
    byFacility: [...by].sort(([a], [b]) => a.localeCompare(b)).map(([code, agents]) => ({ code, agents })),
    unplaced, truncated,
  };
}

/** Every queue's staffing. The roster is used here and not kept. */
export async function pullQueueStaffing(client: CommsClient, report: WorkforceReport, asOf: string): Promise<StaffingSnapshot> {
  const facilityByGenesysId = new Map<string, string | undefined>();
  for (const m of report.members) {
    const g = m.accounts.genesys;
    if (g) facilityByGenesysId.set(g.sourceUserId, m.facility?.code);
  }
  const queues = (await drainGenesys<QueueRow>(client, '/api/v2/routing/queues')).rows;
  const out: QueueStaffing[] = [];
  for (const q of queues) {
    const members = await drainGenesys<MemberRow>(client, '/api/v2/routing/queues/' + encodeURIComponent(q.id) + '/members');
    // The member's id is the user's; `user.id` when present says so outright.
    out.push(staffingOf(q, members.rows.map((m) => m.user?.id ?? m.id), facilityByGenesysId, members.truncated));
  }
  return { asOf, queues: out.sort((a, b) => a.queueName.localeCompare(b.queueName) || a.queueId.localeCompare(b.queueId)) };
}

/** Whether a stored snapshot is recent enough to keep. */
export function staffingIsFresh(stored: StaffingSnapshot | undefined, at: number): boolean {
  return !!stored && at - Date.parse(stored.asOf) < STAFFING_REFRESH_MS;
}
