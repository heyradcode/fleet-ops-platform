/**
 * Queue staffing: members placed through the roster, counted, and never kept
 * as people - and read slowly, because it changes slowly.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now, type ControllableClock } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_CUCM_USER, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN,
  directory, GENESYS_PLANTED_QUEUE, injectFault, mockFetch, resetMockState,
} from './mock/index.ts';
import { createCommsClient, type FetchFn } from './client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { runCommsPoll } from './poll.ts';
import { commsQueueStaffing, putQueueStaffing } from './store.ts';
import { mainTable } from '../../aws/dynamodb.ts';
import { pk } from '../../platform/tenancy.ts';
import { STAFFING_REFRESH_MS, staffingOf } from './staffing.ts';

let clock: ControllableClock;
beforeEach(() => {
  clock = fixedClock();
  setClock(clock);
  resetMockState();
});

function setup(tenantId: string) {
  const config = { ...structuredClone(COMMS_CONFIG[HHS_DEMO_TENANT]), tenantId };
  const principal: Principal = {
    sub: 't', email: 'ops@hhs.texas.example', tenantId, roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  let memberReads = 0;
  const counting: FetchFn = (input, init) => {
    if (/\/routing\/queues\/[^/]+\/members/.test(String(input))) memberReads++;
    return mockFetch(input, init);
  };
  const client = createCommsClient({
    tenantId, fetch: counting, sleep: async () => {},
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT }, genesys: { ...DEMO_CLIENT }, webex: { token: DEMO_WEBEX_TOKEN },
      bandwidth: { ...DEMO_BANDWIDTH_USER }, helix: { ...DEMO_HELIX_USER }, kurmi: { ...DEMO_KURMI_USER }, cucm: { ...DEMO_CUCM_USER },
      starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
    },
  });
  return { principal, poll: () => runCommsPoll(principal, client, config, now()), memberReads: () => memberReads };
}

test('a member counts once; the unplaced are counted, never dropped - they are the denominator too', () => {
  const where = new Map<string, string | undefined>([['a', '1120'], ['b', '1120'], ['c', '0412'], ['d', undefined]]);
  const s = staffingOf({ id: 'q1', name: 'Q' }, ['a', 'b', 'b', 'c', 'd', 'contractor-not-in-roster'], where, false);
  assert.deepEqual(s, {
    queueId: 'q1', queueName: 'Q', members: 5,
    byFacility: [{ code: '0412', agents: 1 }, { code: '1120', agents: 2 }],
    unplaced: 2, truncated: false,
  });
});

test('the poll stores staffing as COUNTS - no member, no name, no id of a person', async () => {
  const { principal, poll } = setup('staff-counts');
  const r = await poll();
  const stored = (await commsQueueStaffing(principal))!;
  assert.deepEqual(stored, r.staffing);
  const planted = stored.queues.find((q) => q.queueName === GENESYS_PLANTED_QUEUE)!;
  const houston = planted.byFacility.find((f) => f.code === '1120')!;
  assert.ok(houston.agents / planted.members >= 0.2, 'the plant: Houston staffs at least a fifth of it');
  assert.ok(planted.unplaced > planted.members / 3, 'and most of the rest cannot be placed - contractors');
  const text = JSON.stringify(stored);
  const genesysIds = directory().people.map((p) => p.ids.genesys).filter(Boolean) as string[];
  assert.ok(!genesysIds.some((id) => text.includes(id)), 'a member id got through');
  assert.ok(!/@|[A-Z]{3,} [A-Z]{3,}/.test(text), 'a name or an address got through');
});

test('structure is read slowly: within the hour the stored copy stands, after it the members are read again', async () => {
  const { poll, memberReads } = setup('staff-refresh');
  await poll();
  const first = memberReads();
  assert.ok(first > 0);
  clock.advance(5 * 60_000);
  await poll();
  assert.equal(memberReads(), first, 'five minutes on: not re-read');
  clock.advance(STAFFING_REFRESH_MS);
  await poll();
  assert.ok(memberReads() > first, 'an hour on: refreshed');
});

test('never refreshed from a poll whose Genesys user list failed - every member would come back unplaced', async () => {
  const { principal, poll } = setup('staff-no-users');
  injectFault('genesys', 503, 1000);
  const r = await poll();
  assert.equal(await commsQueueStaffing(principal), undefined, 'nothing stored rather than a snapshot of nobody');
  const genesys = r.health.sources.find((s) => s.source === 'genesys')!;
  assert.equal(genesys.status, 'down');
  assert.match(genesys.gaps.join(), /queue staffing not refreshed: the Genesys user list failed/);
});

test('a big contact centre is one item per queue, each far under DynamoDB\'s 400 KB - and a queue that went away goes', async () => {
  const { principal } = setup('staff-big');
  const queue = (i: number) => ({
    queueId: 'q-' + String(i).padStart(4, '0'), queueName: 'Queue ' + String(i).padStart(4, '0'), members: 400, unplaced: 100, truncated: false,
    byFacility: Array.from({ length: 60 }, (_, f) => ({ code: String(1000 + f), agents: 5 })),
  });
  const big = { asOf: new Date(now()).toISOString(), queues: Array.from({ length: 600 }, (_, i) => queue(i)) };
  await putQueueStaffing(principal, big);
  const rows = await mainTable.query({ pk: pk(principal, 'COMMS'), skBeginsWith: 'STAFFING#' });
  assert.equal(rows.length, 601, 'one per queue, and the header');
  const largest = Math.max(...rows.map((r) => JSON.stringify(r).length));
  assert.ok(largest < 40_000, 'largest item ' + largest + ' bytes');
  assert.ok(JSON.stringify(big).length > 400_000, 'as ONE item it would not have fitted - the test proves something');
  assert.deepEqual(await commsQueueStaffing(principal), big);

  await putQueueStaffing(principal, { ...big, queues: big.queues.slice(0, 2) });
  assert.deepEqual((await commsQueueStaffing(principal))!.queues.map((q) => q.queueId), ['q-0000', 'q-0001']);
});

test('never refreshed while the directory\'s first sync is unfinished - agents are not placed YET', async () => {
  const { principal, poll } = setup('staff-no-directory');
  injectFault('teams', 503, 1000);   // the Entra sync cannot run: the directory has never synced
  const r = await poll();
  assert.equal(await commsQueueStaffing(principal), undefined, 'no snapshot of "nobody can be placed"');
  assert.match(r.health.sources.find((s) => s.source === 'genesys')!.gaps.join(), /first sync is not finished/);
});
