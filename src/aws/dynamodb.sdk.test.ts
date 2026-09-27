/**
 * The real-table adapter, against a fake `send` that behaves like DynamoDB
 * where the in-memory table does not: small pages, throttled batches, one
 * sort-key condition, no consistent reads on a GSI.
 *
 * The contract test at the end is the one that matters: the whole comms poll
 * run through the adapter must leave the same answer as the in-memory table.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BatchWriteItemCommand, DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand,
  type AttributeValue, type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { DynamoTable, resetTableStore, setTableStore, type Item } from './dynamodb.ts';
import { createSdkTableStore, fromItem, toItem, type Send } from './dynamodb.sdk.ts';
import { setClock, fixedClock, now } from '../platform/clock.ts';
import type { Principal } from '../platform/types.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN,
  directory, mockFetch, resetMockState,
} from '../integrations/comms/mock/index.ts';
import { createCommsClient } from '../integrations/comms/client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from '../integrations/comms/config.ts';
import { runCommsPoll } from '../integrations/comms/poll.ts';
import { commsAlarms, commsIncidents, commsPhones, commsResolvedIncidents, commsWorkforce } from '../integrations/comms/store.ts';
import { loadHealth } from '../integrations/comms/health.ts';
import { latestAnomalies } from '../integrations/comms/anomalies.ts';

/** Items per Query page. Tiny, so every multi-item read has to paginate. */
const PAGE = 3;

type Fake = { send: Send; inner: DynamoTable; calls: string[]; throttleNext: (n: number) => void };

/**
 * DynamoDB, as far as this adapter can tell. Storage is a DynamoTable; the
 * fake's job is the WIRE: marshalled items, key conditions, pages, and
 * UnprocessedItems.
 */
function fakeDynamo(tableName = 't'): Fake {
  const inner = new DynamoTable(tableName);
  const calls: string[] = [];
  let throttle = 0;
  const send: Send = async (command) => {
    const input = (command as { input: Record<string, unknown> }).input;
    assert.equal(input.TableName ?? tableName, tableName);
    if (command instanceof PutItemCommand) {
      calls.push('put');
      await inner.put(fromItem(input.Item as Record<string, AttributeValue>) as Item);
      return {};
    }
    if (command instanceof GetItemCommand) {
      calls.push('get');
      const k = input.Key as { PK: { S: string }; SK: { S: string } };
      const it = await inner.get(k.PK.S, k.SK.S);
      return it ? { Item: toItem(it) } : {};
    }
    if (command instanceof DeleteItemCommand) {
      calls.push('delete');
      const k = input.Key as { PK: { S: string }; SK: { S: string } };
      await inner.delete(k.PK.S, k.SK.S);
      return {};
    }
    if (command instanceof BatchWriteItemCommand) {
      calls.push('batch');
      const reqs = (input.RequestItems as Record<string, WriteRequest[]>)[tableName];
      assert.ok(reqs.length <= 25, 'at most 25 per batch');
      const keys = reqs.map((r) => r.PutRequest!.Item!.PK.S + '|' + r.PutRequest!.Item!.SK.S);
      assert.equal(new Set(keys).size, keys.length, 'DynamoDB refuses duplicate keys in one batch');
      // Throttled: the LAST n requests come back unprocessed, with a 200.
      const n = Math.min(throttle, reqs.length);
      throttle -= n;
      for (const r of reqs.slice(0, reqs.length - n)) await inner.put(fromItem(r.PutRequest!.Item!) as Item);
      return n > 0 ? { UnprocessedItems: { [tableName]: reqs.slice(reqs.length - n) } } : {};
    }
    if (command instanceof QueryCommand) {
      calls.push('query');
      const gsi = input.IndexName === 'GSI1';
      if (gsi) assert.equal(input.ConsistentRead, undefined, 'a GSI cannot be read consistently');
      const names = input.ExpressionAttributeNames as Record<string, string>;
      const values = input.ExpressionAttributeValues as Record<string, AttributeValue>;
      const cond = String(input.KeyConditionExpression);
      for (const n of Object.keys(names)) assert.ok(cond.includes(n), 'unused name ' + n + ' is a ValidationException');
      const all = await inner.query({
        pk: values[':pk'].S!,
        index: gsi ? 'GSI1' : undefined,
        skBeginsWith: values[':sk']?.S,
        skBetween: values[':lo'] ? [values[':lo'].S!, values[':hi'].S!] : undefined,
        scanIndexForward: input.ScanIndexForward as boolean,
      });
      const start = input.ExclusiveStartKey ? Number((input.ExclusiveStartKey as { at: { N: string } }).at.N) : 0;
      const size = Math.min(PAGE, (input.Limit as number | undefined) ?? PAGE);
      const page = all.slice(start, start + size);
      const more = start + size < all.length;
      return { Items: page.map((i) => toItem(i)), ...(more ? { LastEvaluatedKey: { at: { N: String(start + size) } } } : {}) };
    }
    throw new Error('unexpected command ' + command.constructor.name);
  };
  return { send, inner, calls, throttleNext: (n) => { throttle = n; } };
}

const noSleep = async () => {};

beforeEach(() => {
  setClock(fixedClock());
  resetMockState();
});
afterEach(() => resetTableStore());

test('marshalling: nested data survives; undefined is omitted, never stored', () => {
  const record = {
    PK: 'p', SK: 's', n: 3.25, zero: 0, ok: true, none: null, gone: undefined,
    list: ['a', 1, { deep: [false] }], holes: [1, undefined, 3], nested: { a: { b: 'c' }, empty: {} }, blank: '',
  };
  const back = fromItem(toItem(record));
  assert.equal('gone' in back, false);
  assert.deepEqual(back, { ...JSON.parse(JSON.stringify(record)) });
});

test('marshalling: values DynamoDB cannot hold are refused, not coerced', () => {
  assert.throws(() => toItem({ x: Number.NaN }), /non-finite/);
  assert.throws(() => toItem({ x: new Map() }), /plain data/);
  assert.throws(() => toItem({ x: new Date(0) }), /plain data/);
});

test('query follows LastEvaluatedKey to the end - a first page alone is a shorter answer', async () => {
  const f = fakeDynamo();
  const store = createSdkTableStore('t', { send: f.send });
  for (let i = 0; i < 10; i++) await store.put({ PK: 'P', SK: 'K' + i });
  const rows = await store.query({ pk: 'P' });
  assert.equal(rows.length, 10);
  assert.equal(f.calls.filter((c) => c === 'query').length, 4, 'ceil(10 / 3) pages');
});

test('query: limit, direction, prefix and range mean what they mean in memory', async () => {
  const f = fakeDynamo();
  const store = createSdkTableStore('t', { send: f.send });
  const items = Array.from({ length: 8 }, (_, i) => ({ PK: 'P', SK: 'K' + i, GSI1PK: 'G', GSI1SK: 'g' + (7 - i) }));
  await store.batchPut(items);
  const sks = (rows: Item[]) => rows.map((r) => r.SK);
  assert.deepEqual(sks(await store.query({ pk: 'P', scanIndexForward: false, limit: 5 })), ['K7', 'K6', 'K5', 'K4', 'K3']);
  assert.deepEqual(sks(await store.query({ pk: 'P', skBeginsWith: 'K1' })), ['K1']);
  assert.deepEqual(sks(await store.query({ pk: 'P', skBetween: ['K2', 'K4'] })), ['K2', 'K3', 'K4']);
  assert.deepEqual(sks(await store.query({ pk: 'G', index: 'GSI1', limit: 2 })), ['K7', 'K6'], 'GSI1 sorts by GSI1SK');
  await assert.rejects(store.query({ pk: 'P', skBeginsWith: 'K', skBetween: ['K1', 'K2'] }), /cannot be combined/);
});

test('batchPut retries UnprocessedItems - a throttled 200 is not a write', async () => {
  const f = fakeDynamo();
  const store = createSdkTableStore('t', { send: f.send, sleep: noSleep });
  f.throttleNext(30);   // more than one whole batch comes back unprocessed
  const items = Array.from({ length: 40 }, (_, i) => ({ PK: 'P', SK: 'K' + String(i).padStart(2, '0') }));
  await store.batchPut(items);
  assert.equal((await store.query({ pk: 'P' })).length, 40);
  assert.ok(f.calls.filter((c) => c === 'batch').length > 2, 'the unprocessed items were sent again');
});

test('batchPut gives up LOUDLY when throttling never ends', async () => {
  const f = fakeDynamo();
  const store = createSdkTableStore('t', { send: f.send, sleep: noSleep, maxBatchAttempts: 3 });
  f.throttleNext(1_000);
  await assert.rejects(store.batchPut([{ PK: 'P', SK: 'a' }]), /still unprocessed after 3 attempts/);
});

test('batchPut: the same key twice in one call is last-write-wins, as in memory', async () => {
  const f = fakeDynamo();
  const store = createSdkTableStore('t', { send: f.send });
  await store.batchPut([{ PK: 'P', SK: 'a', v: 1 }, { PK: 'P', SK: 'a', v: 2 }]);
  assert.equal((await store.get('P', 'a'))?.v, 2);
});

// ---------------------------------------------------------------------------

const PRINCIPAL: Principal = {
  sub: 'test', email: 'ops-lead@hhs.texas.example', tenantId: HHS_DEMO_TENANT,
  roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
};

const client = () => createCommsClient({
  tenantId: HHS_DEMO_TENANT,
  fetch: mockFetch,
  credentials: {
    entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
    genesys: { ...DEMO_CLIENT },
    webex: { token: DEMO_WEBEX_TOKEN },
    bandwidth: { ...DEMO_BANDWIDTH_USER },
    helix: { ...DEMO_HELIX_USER },
    kurmi: { ...DEMO_KURMI_USER },
    starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
  },
  sleep: noSleep,
});

/** Two polls - the second exercises lifecycle reads of the first's writes - then every read the board makes. */
async function pollTwiceAndRead() {
  resetMockState();
  setClock(fixedClock());
  await runCommsPoll(PRINCIPAL, client(), COMMS_CONFIG[HHS_DEMO_TENANT], now());
  await runCommsPoll(PRINCIPAL, client(), COMMS_CONFIG[HHS_DEMO_TENANT], now() + 5 * 60_000);
  const read = {
    incidents: await commsIncidents(PRINCIPAL),
    resolved: await commsResolvedIncidents(PRINCIPAL),
    alarms: await commsAlarms(PRINCIPAL),
    workforce: await commsWorkforce(PRINCIPAL),
    phones: await commsPhones(PRINCIPAL),
    health: await loadHealth(PRINCIPAL),
    anomalies: await latestAnomalies(PRINCIPAL),
  };
  // Through JSON: the adapter omits undefined attributes, the in-memory table
  // keeps them as keys. Neither is a difference anybody can observe.
  return JSON.parse(JSON.stringify(read)) as typeof read;
}

test('contract: the comms poll leaves the SAME answer through the adapter as in memory', async () => {
  const inMemory = await pollTwiceAndRead();

  const f = fakeDynamo();
  setTableStore(createSdkTableStore('t', { send: f.send, sleep: noSleep }));
  const viaAdapter = await pollTwiceAndRead();

  assert.ok(inMemory.incidents.length > 0 && inMemory.workforce && inMemory.health, 'the comparison compares something');
  assert.deepEqual(viaAdapter, inMemory);
  assert.ok(f.inner.size() > 0, 'and it really went through the adapter');
});
