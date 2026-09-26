/**
 * The comms poll end to end - store, scope, and the agent's tools.
 *
 * The tenancy tests matter as much as the happy path: comms data is the first
 * thing in this platform whose subjects are not sites, so the scope rule had
 * to be restated for it, and these pin the restatement.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import { CrossTenantAccessError, OutOfScopeError } from '../../platform/tenancy.ts';
import { mainTable } from '../../aws/dynamodb.ts';
import { DEMO_CLIENT, DEMO_WEBEX_TOKEN, DEMO_BANDWIDTH_USER, DEMO_HELIX_USER, directory, mockFetch, resetMockState } from './mock/index.ts';
import { createCommsClient } from './client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { runCommsPoll } from './poll.ts';
import { commsAlarms, commsIncidents, commsWorkforce } from './store.ts';
import { commsToolsFor } from '../../ai/comms-tools.ts';
import { toolSpecsFor, TOOL_SPECS } from '../../ai/tools.ts';
import { runAgent } from '../../ai/agent-core.ts';

const principal = (over: Partial<Principal> = {}): Principal => ({
  sub: 'test', email: 'ops-lead@hhs.texas.example', tenantId: HHS_DEMO_TENANT,
  roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito', ...over,
});

const client = (tenantId = HHS_DEMO_TENANT) => createCommsClient({
  tenantId,
  fetch: mockFetch,
  credentials: {
    entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
    genesys: { ...DEMO_CLIENT },
    webex: { token: DEMO_WEBEX_TOKEN },
    bandwidth: { ...DEMO_BANDWIDTH_USER },
    helix: { ...DEMO_HELIX_USER },
  },
  sleep: async () => {},
});

const poll = () => runCommsPoll(principal(), client(), COMMS_CONFIG[HHS_DEMO_TENANT], now());

beforeEach(() => {
  setClock(fixedClock());
  resetMockState();
});

test('poll: incidents, held-back alarms and the workforce split land in the store', async () => {
  const result = await poll();
  const admin = principal();
  assert.equal(commsIncidents(admin).length, result.incidents.length);
  assert.equal(result.incidents.length, 3);
  assert.equal(commsAlarms(admin).length, result.alarms.length);
  assert.ok(commsWorkforce(admin)!.byFacility.length > 0);
});

test('poll: a re-poll of the same window overwrites, it does not duplicate', async () => {
  await poll();
  await poll();
  assert.equal(commsIncidents(principal()).length, 3);
});

test('store: no person-level data is persisted - counts, not names', async () => {
  await poll();
  const stored = mainTable.query({ pk: 'TENANT#' + HHS_DEMO_TENANT + '#COMMS' });
  const text = JSON.stringify(stored);
  assert.ok(!text.includes('@'), 'no email address in the stored workforce');
  for (const p of directory().people.slice(0, 20)) assert.ok(!text.includes(p.lastName), p.lastName);
});

test('scope: a site-scoped caller can neither read comms data nor be offered the tools', async () => {
  await poll();
  const siteOperator = principal({ roles: ['operator'], scope: { kind: 'site', siteId: 'hou-01' } });
  assert.throws(() => commsIncidents(siteOperator), OutOfScopeError);
  assert.deepEqual(commsToolsFor(siteOperator), []);
});

test('tenancy: another tenant sees nothing, and cannot poll with this tenant\'s client', async () => {
  await poll();
  const other = principal({ tenantId: 'acme-networks' });
  assert.deepEqual(commsIncidents(other), []);
  assert.deepEqual(commsToolsFor(other), [], 'acme runs no comms sources');
  assert.deepEqual(toolSpecsFor(other, { readOnly: false }), TOOL_SPECS, 'network callers are unchanged');

  await assert.rejects(runCommsPoll(other, client(), COMMS_CONFIG[HHS_DEMO_TENANT], now()), CrossTenantAccessError);
});

test('agent: answers a call-quality question from the comms tools, grounded in them', async () => {
  await poll();
  const admin = principal();
  const result = await runAgent({
    question: 'Why is call quality bad in Houston, and did anything page?',
    principal: admin,
    tools: commsToolsFor(admin),
  });
  const called = result.trace.filter((t) => t.kind === 'tool').map((t) => t.detail.split('(')[0]);
  assert.deepEqual(called, ['listCommsIncidents', 'queryWorkforce']);
  assert.equal(result.stoppedBecause, 'end_turn');
  assert.match(result.answer, /LC=1120/);
  assert.match(result.answer, /teams \+ webex/);
});
