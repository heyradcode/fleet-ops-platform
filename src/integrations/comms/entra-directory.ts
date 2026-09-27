/**
 * ---------------------------------------------------------------------------
 * The Entra directory, kept in sync with Graph's delta query
 * ---------------------------------------------------------------------------
 * Why this exists: facility placement needs every Entra user's street address
 * (the `LC=` code), and this customer has ~75,000 of them. A full `/users`
 * listing every poll is ~76 pages of 999 - past `MAX_PAGES_PER_RUN`, so it
 * came back truncated, and it spent the tenant's Graph quota re-reading a
 * directory that changes by a handful of people a day.
 *
 * `/users/delta` fixes both. One full listing, then only changes. This file
 * owns that protocol and the copy of the directory it maintains.
 *
 * THE FIRST SYNC SPANS RUNS. 76 pages is more than one run may fetch, so a run
 * that hits the ceiling saves the nextLink it stopped at and the next run
 * resumes there. The protocol is designed for this - a nextLink is resumable
 * state - and the alternative, starting over each run, would never finish.
 *
 * GENERATIONS, SO NOBODY READS A HALF-BUILT DIRECTORY. A full sync writes a
 * NEW generation beside the committed one and flips a pointer when its last
 * page lands. Until then readers see the previous generation (marked stale)
 * or, on a first-ever sync, nothing (marked incomplete). A delta token that
 * has expired (410) starts a new generation the same way, so a resync never
 * blanks the board for the hours it takes.
 *
 * WRITES BEFORE THE LINK, the watermark rule from CLAUDE.md: the deltaLink or
 * resume link is saved only AFTER the rows it covers are written. Save it
 * first and a crash between the two loses those changes permanently - the
 * next delta starts after them and nothing reports a gap.
 *
 * PSEUDONYMISED AT REST. What is stored per user is a salted hash of their
 * address and a facility code - never the address itself. The join hashes
 * the other platforms' addresses the same way to look people up. This is
 * pseudonymisation, not anonymisation: anyone holding the tenant id and a
 * candidate address can confirm a match, which is exactly the lookup the join
 * needs and exactly why the salt is per tenant - the same person at two
 * customers does not correlate.
 */
import { sha256 } from '../../platform/crypto.ts';
import { mainTable } from '../../aws/dynamodb.ts';
import { forEachByKey } from '../../platform/concurrency.ts';
import { pk } from '../../platform/tenancy.ts';
import { drainPages, type HttpPage, type PageCursor } from '../http.ts';
import type { Principal } from '../../platform/types.ts';
import { CommsHttpError, type CommsClient } from './client.ts';
import { facilityFromAddress } from './classify.ts';
import type { UnplacedReason } from './types.ts';

export type Placement = { code: string } | { unplaced: UnplacedReason };

export type DirectoryStatus =
  | 'never-synced'
  | 'first-sync-in-progress'   // nothing committed yet; readers get nothing
  | 'resyncing'                // a new generation is building; readers get the old one
  | 'complete';

/** What the workforce join reads. Pure lookups over the committed generation. */
export type EntraDirectoryView = {
  status: DirectoryStatus;
  users: number;
  placementById(objectId: string): Placement | undefined;
  placementByEmail(email: string): Placement | undefined;
};

export type EntraSyncResult = {
  status: DirectoryStatus;
  mode: 'full' | 'delta';
  pages: number;
  /** Rows written: every user on a full sync page, only changes on a delta. */
  rowsApplied: number;
  removed: number;
  /** The delta token had expired and a full resync began. */
  resyncStarted: boolean;
};

type SyncState = {
  committedGen: number | null;
  deltaLink: string | null;
  /** A full sync in progress: its generation and where to resume. */
  building: { gen: number; next: string } | null;
  /** A delta drain that hit the page ceiling, and where to resume it. */
  deltaResume: string | null;
  nextGen: number;
};

type Row = {
  id: string;
  userPrincipalName?: string;
  streetAddress?: string | null;
  '@removed'?: { reason: string };
};

type StoredUser = { objectId: string; emailHash?: string; placement?: Placement };

const SELECT = 'id,userPrincipalName,streetAddress';

export function emailHash(tenantId: string, email: string): string {
  return sha256(tenantId + '|' + email.trim().toLowerCase()).slice(0, 32);
}

const statePk = (p: Principal) => pk(p, 'COMMS');
const STATE_SK = 'ENTRA#SYNC';
const dirPk = (p: Principal) => pk(p, 'COMMSDIR');
const userSk = (gen: number, id: string) => 'G' + gen + '#' + id;

async function loadState(principal: Principal): Promise<SyncState> {
  const item = await mainTable.get(statePk(principal), STATE_SK);
  if (!item) return { committedGen: null, deltaLink: null, building: null, deltaResume: null, nextGen: 1 };
  const { PK, SK, entity, ...state } = item;
  return state as unknown as SyncState;
}

async function saveState(principal: Principal, state: SyncState): Promise<void> {
  await mainTable.put({ PK: statePk(principal), SK: STATE_SK, entity: 'EntraSyncState', ...state });
}

function statusOf(state: SyncState): DirectoryStatus {
  if (state.committedGen === null) return state.building ? 'first-sync-in-progress' : 'never-synced';
  return state.building ? 'resyncing' : 'complete';
}

/**
 * Apply rows to one generation. Rows are MERGED, not overwritten: a delta row
 * carries only what changed, so a rename arrives without a street address and
 * must not erase the facility the user already had.
 */
async function applyRows(principal: Principal, gen: number, rows: Row[]): Promise<{ applied: number; removed: number }> {
  let applied = 0;
  let removed = 0;
  // Per USER in order - a delta can carry the same user twice, and the second
  // change must merge into the first, not race it from the old row - and
  // different users in parallel. Against a real table that is a read and a
  // write per user either way; in parallel, a first sync of thousands is a
  // few hundred round trips rather than several thousand.
  await forEachByKey(rows, (row) => row.id, async (row) => {
    const sk = userSk(gen, row.id);
    if (row['@removed']) {
      await mainTable.delete(dirPk(principal), sk);
      removed++;
      return;
    }
    const prev = await mainTable.get(dirPk(principal), sk) as (StoredUser & { PK: string; SK: string }) | undefined;
    const next: StoredUser = { objectId: row.id, emailHash: prev?.emailHash, placement: prev?.placement };
    if (row.userPrincipalName !== undefined) next.emailHash = emailHash(principal.tenantId, row.userPrincipalName);
    if (row.streetAddress !== undefined) next.placement = facilityFromAddress(row.streetAddress);
    await mainTable.put({ PK: dirPk(principal), SK: sk, entity: 'EntraUser', ...next });
    applied++;
  });
  return { applied, removed };
}

async function dropGeneration(principal: Principal, gen: number): Promise<void> {
  // Every key distinct, so all in parallel (bounded) - one round trip per
  // user in sequence was the slowest part of a resync against a real table.
  const items = await mainTable.query({ pk: dirPk(principal), skBeginsWith: 'G' + gen + '#' });
  await forEachByKey(items, (item) => item.SK, (item) => mainTable.delete(item.PK, item.SK));
}

/** Drain from a link, returning the rows, the deltaLink if the drain finished, and where it stopped. */
async function drain(client: CommsClient, url: string, pageSize: number) {
  let deltaLink: string | null = null;
  const result = await drainPages(async (cursor: PageCursor): Promise<HttpPage> => {
    if (cursor.kind !== 'link-header') throw new Error('graph cursor must be a link');
    const res = await client.request('teams', cursor.next, {
      headers: { Prefer: 'odata.maxpagesize=' + pageSize },
    });
    const body = await res.json() as { value: Row[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
    if (body['@odata.deltaLink']) deltaLink = body['@odata.deltaLink'];
    const next = body['@odata.nextLink'];
    return { records: body.value, next: next ? { kind: 'link-header', next } : { kind: 'done' } };
  }, { kind: 'link-header', next: url });
  const resumeAt = result.next.kind === 'link-header' ? result.next.next : null;
  return { rows: result.records as Row[], pages: result.pages, deltaLink: deltaLink as string | null, resumeAt };
}

/**
 * One run of the sync. Call it every poll; it does whichever of these the
 * saved state calls for: start a full sync, resume one, or apply a delta.
 */
export async function syncEntraDirectory(
  principal: Principal, client: CommsClient, opts: { pageSize?: number } = {},
): Promise<EntraSyncResult> {
  const pageSize = opts.pageSize ?? 999;
  const state = await loadState(principal);
  const initialUrl = client.endpoints.graph + '/users/delta?$select=' + SELECT;
  let resyncStarted = false;

  // --- Delta, when there is a committed generation and no full sync running.
  if (state.committedGen !== null && !state.building && (state.deltaLink || state.deltaResume)) {
    try {
      const d = await drain(client, (state.deltaResume ?? state.deltaLink)!, pageSize);
      const { applied, removed } = await applyRows(principal, state.committedGen, d.rows);
      // AFTER the writes. See the header.
      if (d.deltaLink) { state.deltaLink = d.deltaLink; state.deltaResume = null; }
      else state.deltaResume = d.resumeAt;
      await saveState(principal, state);
      return { status: statusOf(state), mode: 'delta', pages: d.pages, rowsApplied: applied, removed, resyncStarted };
    } catch (err) {
      if (!(err instanceof CommsHttpError && err.status === 410)) throw err;
      // The token expired. Build a fresh generation; keep serving the old one.
      state.building = { gen: state.nextGen++, next: initialUrl };
      state.deltaLink = null;
      state.deltaResume = null;
      await saveState(principal, state);
      resyncStarted = true;
    }
  }

  // --- Full sync: start one, or resume the one in progress.
  if (!state.building) state.building = { gen: state.nextGen++, next: initialUrl };
  const building = state.building;
  const d = await drain(client, building.next, pageSize);
  const { applied } = await applyRows(principal, building.gen, d.rows);

  if (d.deltaLink) {
    // The last page landed: flip readers to the new generation, then clear
    // the old one. Flip first - a crash between the two leaves garbage, which
    // the next resync clears; the other order would leave readers with nothing.
    const old = state.committedGen;
    state.committedGen = building.gen;
    state.deltaLink = d.deltaLink;
    state.building = null;
    await saveState(principal, state);
    if (old !== null) await dropGeneration(principal, old);
  } else {
    building.next = d.resumeAt ?? building.next;
    await saveState(principal, state);
  }
  return { status: statusOf(state), mode: 'full', pages: d.pages, rowsApplied: applied, removed: 0, resyncStarted };
}

/** The committed generation, as lookups. Reads nothing person-identifying back out. */
export async function loadEntraDirectory(principal: Principal): Promise<EntraDirectoryView> {
  const state = await loadState(principal);
  const byId = new Map<string, Placement>();
  const byHash = new Map<string, Placement>();
  if (state.committedGen !== null) {
    for (const item of await mainTable.query({ pk: dirPk(principal), skBeginsWith: 'G' + state.committedGen + '#' })) {
      const u = item as unknown as StoredUser;
      const placement = u.placement ?? { unplaced: 'no-facility-code' as const };
      byId.set(u.objectId, placement);
      if (u.emailHash) byHash.set(u.emailHash, placement);
    }
  }
  return {
    status: statusOf(state),
    users: byId.size,
    placementById: (id) => byId.get(id),
    placementByEmail: (email) => byHash.get(emailHash(principal.tenantId, email)),
  };
}

/** For callers with no directory - tests of the pure join, mainly. */
export const EMPTY_DIRECTORY: EntraDirectoryView = {
  status: 'never-synced',
  users: 0,
  placementById: () => undefined,
  placementByEmail: () => undefined,
};
