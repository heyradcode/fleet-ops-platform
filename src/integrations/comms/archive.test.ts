/**
 * The comms archive: what a real poll writes, that it holds no person, and
 * that neither a leak nor a broken bucket can cost the poll anything.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import { memoryCommsArchive, resetCommsArchiveStore, setCommsArchiveStore, MemoryObjectStore } from '../../aws/s3.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_CUCM_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN,
  directory, mockFetch, resetMockState,
} from './mock/index.ts';
import { createCommsClient } from './client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { runCommsPoll, type CommsPollResult } from './poll.ts';
import { archiveCommsPoll, ARCHIVE_SCHEMA } from './archive.ts';

const HHS: Principal = {
  sub: 'archive', email: 'a@x', tenantId: HHS_DEMO_TENANT, roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
};

async function poll(): Promise<CommsPollResult> {
  resetMockState();
  setClock(fixedClock());
  return runCommsPoll(HHS, createCommsClient({
    tenantId: HHS_DEMO_TENANT, fetch: mockFetch, sleep: async () => {},
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
      genesys: { ...DEMO_CLIENT }, webex: { token: DEMO_WEBEX_TOKEN }, bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER }, kurmi: { ...DEMO_KURMI_USER }, cucm: { ...DEMO_CUCM_USER }, starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
    },
  }), COMMS_CONFIG[HHS_DEMO_TENANT], now());
}

let result: CommsPollResult;
const everything = () => memoryCommsArchive.keys('comms/').map((k) => memoryCommsArchive.get(k)!.body).join('\n');

before(async () => {
  resetCommsArchiveStore();
  memoryCommsArchive.clear();
  result = await poll();
});
beforeEach(() => resetCommsArchiveStore());

test('a poll archives five JSON Lines objects, hive-partitioned for Athena, keyed by the poll time', () => {
  assert.equal(result.archive.status, 'written');
  const keys = memoryCommsArchive.keys('comms/');
  assert.deepEqual(keys.map((k) => k.split('/')[1]), ['alarms', 'health', 'incidents', 'signals', 'workforce']);
  for (const k of keys) assert.match(k, /^comms\/\w+\/tenant=hhs-demo\/dt=2026-09-08\/hh=14\/20260908T\d{6}Z\.jsonl$/);
  assert.equal(memoryCommsArchive.get(keys[0])!.contentType, 'application/x-ndjson');
});

test('every line stands on its own: schema, tenant, poll time - and the signals are all of them', () => {
  const signalsKey = memoryCommsArchive.keys('comms/signals/')[0];
  const lines = memoryCommsArchive.get(signalsKey)!.body.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, result.signals.length);
  for (const l of lines) {
    assert.equal(l.schema, ARCHIVE_SCHEMA);
    assert.equal(l.tenantId, HHS_DEMO_TENANT);
    assert.match(String(l.polledAt), /^2026-09-08T14:/);
  }
  const incidents = memoryCommsArchive.get(memoryCommsArchive.keys('comms/incidents/')[0])!.body.trim().split('\n');
  assert.equal(incidents.length, result.incidents.length + result.resolved.length);
});

test('NO PEOPLE: not one name, email, address, phone or vendor id from the directory reaches the archive', () => {
  const text = everything();
  assert.ok(text.length > 1000, 'the archive has real content to search');
  const people = directory().people;
  assert.ok(people.length > 50);
  for (const p of people) {
    const traces = [p.email, p.email.toLowerCase(), p.firstName + ' ' + p.lastName, p.streetAddress, p.ids.entra, p.ids.genesys, p.ids.webex, p.phone]
      .filter((t): t is string => !!t && t.length > 4);
    for (const t of traces) assert.ok(!text.includes(t), 'found a trace of a person: ' + t.slice(0, 3) + '...');
  }
  assert.ok(!/@/.test(text), 'no address of any kind');
  // And the counts ARE there: the workforce as numbers.
  assert.match(memoryCommsArchive.get(memoryCommsArchive.keys('comms/workforce/')[0])!.body, /"byFacility":\[\{"code":"/);
});

test('the tripwire: an email that reached a signal refuses the WHOLE archive, and the reason never quotes it', async () => {
  const store = new MemoryObjectStore('tripwire');
  const leaked = { ...result.signals[0], detail: 'poor audio for jane.doe@hhs.texas.example' };
  const r = await archiveCommsPoll(HHS, { ...result, signals: [leaked, ...result.signals.slice(1)] }, now(), store);
  assert.equal(r.status, 'refused');
  assert.match((r as { reason: string }).reason, /an email address in the signals record/);
  assert.ok(!(r as { reason: string }).reason.includes('jane'), 'quoting the match would write the thing refused');
  assert.deepEqual(store.keys(), [], 'nothing written - not even the records that were clean');
  const phone = await archiveCommsPoll(HHS, { ...result, alarms: [{ ...result.alarms[0], subject: { ...result.alarms[0].subject, name: 'call +15125550123' } }] }, now(), store);
  assert.equal(phone.status, 'refused');
});

test('a bucket that fails costs the backup, never the poll', async () => {
  setCommsArchiveStore({ name: 'broken', put: async () => { throw new Error('AccessDenied'); } });
  const r = await poll();
  assert.equal(r.archive.status, 'failed');
  assert.match((r.archive as { error: string }).error, /AccessDenied/);
  assert.ok(r.incidents.length > 0, 'the poll decided and stored everything as usual');
});

test('archiving the same poll again overwrites the same keys - re-runs cost nothing', async () => {
  const store = new MemoryObjectStore('idempotent');
  await archiveCommsPoll(HHS, result, now(), store);
  const first = store.keys();
  await archiveCommsPoll(HHS, result, now(), store);
  assert.deepEqual(store.keys(), first);
});
