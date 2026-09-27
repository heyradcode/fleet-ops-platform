/**
 * The Incident Agent's change lookup: Helix along a device's uplink chain.
 *
 * The negative cases carry the weight: a sibling's change must never be
 * offered as a cause, a CMDB printer must never count as inventory drift, and
 * "Helix could not be asked" must never read as "nothing changed".
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now } from '../../platform/clock.ts';
import { setRandom, seededRandom } from '../../platform/random.ts';
import { setUuid, seededUuid } from '../../platform/crypto.ts';
import type { Principal } from '../../platform/types.ts';
import { getInventory, loadEstate } from '../../geo/device-repository.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN, directory,
  HELIX_PLANTED, injectFault, mockFetch, resetMockState,
} from './mock/index.ts';
import { createCommsClient } from './client.ts';
import { resetHelixClientFactory, setHelixClientFactory } from './helix.ts';
import { changesAroundDevice } from './helix-network.ts';
import { toolByName, toolSpecsFor, TOOL_SPECS } from '../../ai/tools.ts';
import { runAgent } from '../../ai/agent-core.ts';

const HHS: Principal = {
  sub: 't', email: 'neteng@hhs.texas.example', tenantId: 'hhs-demo',
  roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
};
const DEAD = 'dev-dis-dal01-04';

function wireHelix(): void {
  const client = createCommsClient({
    tenantId: 'hhs-demo', fetch: mockFetch,
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT }, genesys: { ...DEMO_CLIENT },
      webex: { token: DEMO_WEBEX_TOKEN }, bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER }, kurmi: { ...DEMO_KURMI_USER }, starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
    },
    sleep: async () => {},
  });
  setHelixClientFactory((t) => (t === 'hhs-demo' ? client : undefined));
}

beforeEach(() => {
  setClock(fixedClock());
  const rng = seededRandom();
  setRandom(rng);
  setUuid(seededUuid(rng));
  resetMockState();
  loadEstate('hhs-demo');
  wireHelix();
});
afterEach(() => resetHelixClientFactory());

test('the device first, then up its uplink chain - and never sideways', async () => {
  const r = await changesAroundDevice(HHS, DEAD, now());
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.changes.map((c) => [c.id, c.hops]), [
    [HELIX_PLANTED.deviceChange, 0],
    [HELIX_PLANTED.upstreamChange, 1],
  ]);
  assert.equal(r.changes[0].endedMinutesBefore, 22);
  assert.ok(!r.changes.some((c) => c.id === HELIX_PLANTED.siblingChange),
    'the sibling changed more recently than the core, and is still not a cause');
});

test('asking Helix never inflates inventory drift - the printer CI is not "an unknown device"', async () => {
  const inventory = getInventory(HHS);
  inventory.takeUnresolved();
  await changesAroundDevice(HHS, DEAD, now());
  assert.deepEqual(inventory.takeUnresolved(), []);
});

test('not configured and unavailable are said as such - never as "no changes"', async () => {
  resetHelixClientFactory();
  const off = await changesAroundDevice(HHS, DEAD, now());
  assert.equal(off.status, 'not-configured');
  assert.match((off as { note: string }).note, /UNKNOWN, not empty/);

  wireHelix();
  injectFault('helix', 503, 1000);
  const down = await changesAroundDevice(HHS, DEAD, now());
  assert.equal(down.status, 'unavailable');
});

test('the tool is offered only where Helix is wired, and respects the caller\'s scope', async () => {
  assert.ok(toolSpecsFor(HHS, { readOnly: true }).some((t) => t.name === 'recentChanges'));
  const acme: Principal = { ...HHS, tenantId: 'acme-networks' };
  assert.ok(!toolSpecsFor(acme, { readOnly: true }).some((t) => t.name === 'recentChanges'));

  // Scoped to a device other than the one asked about: an error, not an answer.
  const fieldEngineer: Principal = { ...HHS, roles: ['engineer'], scope: { kind: 'device', deviceId: 'dev-acc-dal01-05' } };
  const out = await toolByName('recentChanges')!.execute({ deviceId: DEAD }, fieldEngineer);
  assert.match(out, /^ERROR: unknown or out-of-scope/);
});

test('the Incident Agent: topology and changes together name the candidate', async () => {
  const tools = [...TOOL_SPECS.filter((t) => t.name === 'traceTopology'),
    ...toolSpecsFor(HHS, { readOnly: true }).filter((t) => t.name === 'recentChanges')];
  const r = await runAgent({ question: 'Why is ' + DEAD + ' unreachable - did anything change?', principal: HHS, tools });
  const called = r.trace.filter((t) => t.kind === 'tool').map((t) => t.detail.split('(')[0]);
  assert.deepEqual(called, ['traceTopology', 'recentChanges']);
  assert.match(r.answer, new RegExp(HELIX_PLANTED.deviceChange));
});
