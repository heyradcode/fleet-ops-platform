/**
 * The daily brief. What is pinned is what an executive would be misled by:
 * a figure that is not the stored one, people counted twice, a calm status
 * over missing data.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now, type ControllableClock } from '../platform/clock.ts';
import type { Principal } from '../platform/types.ts';
import { OutOfScopeError } from '../platform/tenancy.ts';
import {
  clearFaults, DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_CUCM_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN,
  directory, injectFault, mockFetch, resetMockState, setPlanted, TEAMS_PLANTED,
} from '../integrations/comms/mock/index.ts';
import { createCommsClient } from '../integrations/comms/client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from '../integrations/comms/config.ts';
import { runCommsPoll } from '../integrations/comms/poll.ts';
import { commsIncidents, commsWorkforce } from '../integrations/comms/store.ts';
import { buildDailyBrief, renderBrief } from './daily-brief.ts';

let clock: ControllableClock;
beforeEach(() => {
  clock = fixedClock();
  setClock(clock);
  resetMockState();
});

/** A tenant of its own - the brief reads history, and a shared one would leak it. */
function setup(tenantId: string) {
  COMMS_CONFIG[tenantId] = { ...structuredClone(COMMS_CONFIG[HHS_DEMO_TENANT]), tenantId };
  const principal: Principal = {
    sub: 't', email: 'ops-lead@hhs.texas.example', tenantId,
    roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  const client = createCommsClient({
    tenantId, fetch: mockFetch,
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT }, genesys: { ...DEMO_CLIENT },
      webex: { token: DEMO_WEBEX_TOKEN }, bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER }, kurmi: { ...DEMO_KURMI_USER }, cucm: { ...DEMO_CUCM_USER }, starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
    },
    sleep: async () => {},
  });
  const poll = async () => { await runCommsPoll(principal, client, COMMS_CONFIG[tenantId], now()); };
  return { principal, poll };
}

const noNetwork = { networkIncidents: [] };

test('red, in plain words, with impact in people and calls', async () => {
  const { principal, poll } = setup('b-red');
  await poll();
  const b = await buildDailyBrief(principal, now(), noNetwork);
  assert.equal(b.status, 'red');
  assert.equal(b.open.length, 5);
  const titles = b.open.map((o) => o.title).join(' | ');
  assert.match(titles, /Houston Regional/, 'a facility name an executive knows, not a bare LC code');
  assert.match(titles, /Phone calls through trunk SBC2 are failing/);

  const trunk = b.open.find((o) => o.title.includes('SBC2'))!;
  assert.match(trunk.impact, /^up to \d+%/, 'Teams and the carrier count different calls - a ceiling, not "the" rate');
  assert.match(trunk.impact, /Teams \d+ of \d+; carrier \d+ of \d+/);
  assert.match(trunk.candidate!, /CRQ000000104530/);

  // Not call QUALITY: those phones make no calls. Counted in phones, and in people.
  const elPaso = b.open.find((o) => o.title.includes('LC=2031'))!;
  assert.match(elPaso.title, /^Desk phones not working at .*\(LC=2031\)$/);
  assert.match(elPaso.impact, /^\d+ of \d+ desk phones cannot make or take calls; up to \d+ people/);
});

test('figures are the stored ones - quoted, never recomputed', async () => {
  const { principal, poll } = setup('b-figures');
  await poll();
  const b = await buildDailyBrief(principal, now(), noNetwork);
  const queue = (await commsIncidents(principal)).find((i) => i.subject.kind === 'queue')!;
  const waiting = queue.figures.find((f) => f.kind === 'queue-backlog')!.value;
  const item = b.open.find((o) => o.area === 'contact centre')!;
  assert.match(item.impact, new RegExp('^' + waiting + ' callers waiting'));
});

test('people at a facility are counted ONCE, however many platforms they are on', async () => {
  const { principal, poll } = setup('b-people');
  await poll();
  const code = TEAMS_PLANTED.degradedFacility;
  const row = (await commsWorkforce(principal))!.byFacility.find((f) => f.code === code)!;
  // EMPLOYEES only: a contractor is not in Entra and Genesys holds no
  // facility, so the platform cannot place one - they are reported as
  // unplaced, never guessed into a building.
  const truth = directory().people.filter((p) => p.kind === 'employee' &&
    p.facility?.code === code && (p.teamsVoice || (p.inGenesys && p.genesysActive) || p.inWebex)).length;
  assert.equal(row.people, truth);
  const sum = Object.values(row.counts).reduce((a, b) => a + (b ?? 0), 0);
  assert.ok(row.people < sum, 'the platform columns overlap - which is why the sum is wrong');

  const b = await buildDailyBrief(principal, now(), noNetwork);
  assert.match(b.open.find((o) => o.title.includes('Houston'))!.impact, new RegExp('up to ' + truth + ' people'));
});

test('recovered: green, with the resolved problems and how long they lasted', async () => {
  const { principal, poll } = setup('b-green');
  await poll();
  setPlanted(false);
  for (let n = 0; n < 3; n++) { clock.advance(5 * 60_000); await poll(); }
  const b = await buildDailyBrief(principal, now(), noNetwork);
  assert.equal(b.status, 'green');
  assert.equal(b.open.length, 0);
  assert.equal(b.resolved.length, 5);
  assert.ok(b.resolved.every((r) => /^lasted /.test(r.when)));
});

test('nothing open but a feed down is AMBER, and says which - never a calm green over missing data', async () => {
  const { principal, poll } = setup('b-amber');
  await poll();
  setPlanted(false);
  for (let n = 0; n < 3; n++) { clock.advance(5 * 60_000); await poll(); }
  injectFault('genesys', 503, 10_000);
  clock.advance(5 * 60_000);
  await poll();
  clearFaults();
  const b = await buildDailyBrief(principal, now(), noNetwork);
  assert.equal(b.status, 'amber');
  assert.equal(b.confidence.complete, false);
  assert.ok(b.confidence.notes.some((n) => n.startsWith('genesys is not responding')));
  assert.match(renderBrief(b, 'text'), /Built on incomplete data/);
});

test('the brief is for tenant-wide principals only', async () => {
  const { principal, poll } = setup('b-scope');
  await poll();
  const site: Principal = { ...principal, roles: ['operator'], scope: { kind: 'site', siteId: 'x' } };
  await assert.rejects(buildDailyBrief(site, now(), noNetwork), OutOfScopeError);
});
