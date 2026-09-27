/**
 * Integration health, and the isolation that makes it meaningful: one source
 * failing must cost that source's data and nothing else.
 *
 * Each test runs as its own tenant, because health records carry history
 * across polls (that is their point) and a shared tenant would leak it.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now, type ControllableClock } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import { OutOfScopeError } from '../../platform/tenancy.ts';
import {
  clearFaults, DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN, directory,
  injectFault, mockFetch, resetMockState, TEAMS_PLANTED,
} from './mock/index.ts';
import { createCommsClient } from './client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { runCommsPoll } from './poll.ts';
import { loadHealth, STALE_AFTER_MS, type SourceHealth } from './health.ts';
import type { CommsTenantConfig } from './types.ts';

let clock: ControllableClock;
beforeEach(() => {
  clock = fixedClock();
  setClock(clock);
  resetMockState();
});

function setup(tenantId: string, tweak: (c: CommsTenantConfig) => void = () => {}) {
  const config = { ...structuredClone(COMMS_CONFIG[HHS_DEMO_TENANT]), tenantId };
  tweak(config);
  const principal: Principal = {
    sub: 't', email: 'ops@hhs.texas.example', tenantId,
    roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  const client = createCommsClient({
    tenantId, fetch: mockFetch,
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
      genesys: { ...DEMO_CLIENT },
      webex: { token: DEMO_WEBEX_TOKEN },
      bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER },
      kurmi: { ...DEMO_KURMI_USER },
      starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
    },
    sleep: async () => {},
  });
  return { principal, poll: () => runCommsPoll(principal, client, config, now()) };
}

const byName = (sources: SourceHealth[]) => Object.fromEntries(sources.map((s) => [s.source, s]));

test('a normal poll: every source healthy, caveats shown but not a status', async () => {
  const { poll } = setup('h-normal');
  const { health } = await poll();
  const s = byName(health.sources);
  for (const name of ['entra-directory', 'teams', 'genesys', 'webex', 'bandwidth', 'helix', 'kurmi', 'starlink']) {
    assert.equal(s[name].status, 'healthy', name);
  }
  assert.match(s.bandwidth.caveats.join(), /PLACEHOLDER/);
  // The legacy PBX peer is a data-quality item with a named fix, not a failure.
  const peer = health.dataQuality.find((q) => q.kind === 'unmapped-bandwidth-peer')!;
  assert.match(peer.detail, /540103/);
  assert.match(peer.action, /peerTrunk/);
});

test('Genesys down: the poll survives, the rest is untouched, and the queue incident is simply absent', async () => {
  const { poll } = setup('h-genesys');
  injectFault('genesys', 503, 1000);
  const r = await poll();
  const s = byName(r.health.sources);
  assert.equal(s.genesys.status, 'down');
  assert.match(s.genesys.lastError!, /503/);
  assert.equal(s.genesys.stale, true, 'never had good data');
  for (const ok of ['teams', 'webex', 'bandwidth', 'helix']) assert.equal(s[ok].status, 'healthy', ok);
  // Houston's call quality, Lubbock's satellite link, SBC2 - not the queue.
  assert.deepEqual(r.incidents.map((i) => i.subject.kind).sort(), ['facility', 'facility', 'trunk']);
  assert.equal(r.report.byPlatform.genesys, undefined, 'absent, not zero');
});

test('down, then stale after fifteen minutes, then recovered - history carries across polls', async () => {
  const { poll } = setup('h-history');
  await poll();                                   // good data at t0
  injectFault('genesys', 503, 1000);

  let s = byName((await poll()).health.sources);
  assert.equal(s.genesys.status, 'down');
  assert.equal(s.genesys.stale, false, 'last good data is seconds old');
  assert.equal(s.genesys.consecutiveFailures, 1);

  clock.advance(STALE_AFTER_MS + 60_000);
  s = byName((await poll()).health.sources);
  assert.equal(s.genesys.stale, true);
  assert.equal(s.genesys.consecutiveFailures, 2);
  assert.ok(s.genesys.lastSuccessAt, 'the last success is remembered, not overwritten');

  clearFaults();
  s = byName((await poll()).health.sources);
  assert.equal(s.genesys.status, 'healthy');
  assert.equal(s.genesys.consecutiveFailures, 0);
});

test('Webex down: Houston is held back, and the reason says Webex could not be ASKED', async () => {
  const { poll } = setup('h-webex');
  injectFault('webex', 503, 1000);
  const r = await poll();
  const houston = r.alarms.find((a) => a.subject.id === TEAMS_PLANTED.degradedFacility)!;
  assert.equal(houston.corroborated, false);
  assert.match(houston.heldBack!, /webex was UNAVAILABLE/);
  assert.doesNotMatch(houston.heldBack!, /needs a second/);
});

test('Helix down: its row is down, and the incidents are all still there', async () => {
  const { poll } = setup('h-helix');
  injectFault('helix', 503, 1000);
  const r = await poll();
  assert.equal(byName(r.health.sources).helix.status, 'down');
  assert.equal(r.incidents.length, 4);
  assert.ok(r.incidents.every((i) => i.context?.status === 'unavailable'));
});

test('a configuration gap is a data-quality issue with the fix named', async () => {
  const { poll } = setup('h-quality', (c) => {
    c.contractorDomains = c.contractorDomains.filter((d) => d !== 'staffing-co.example');
  });
  const { health } = await poll();
  const issue = health.dataQuality.find((q) => q.kind === 'unknown-domain')!;
  assert.match(issue.detail, /staffing-co\.example/);
  assert.match(issue.action, /contractorDomains/);
});

test('health is stored, and read back only at tenant scope', async () => {
  const { poll, principal } = setup('h-scope');
  await poll();
  assert.equal(loadHealth(principal)!.sources.length, 8);
  const site: Principal = { ...principal, roles: ['operator'], scope: { kind: 'site', siteId: 'x' } };
  assert.throws(() => loadHealth(site), OutOfScopeError);
});
