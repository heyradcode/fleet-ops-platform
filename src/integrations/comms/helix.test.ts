/**
 * Helix: the AR System connector, and context on comms incidents.
 *
 * The context tests assert what does NOT match as hard as what does. A
 * correlation that attached the three-day-old Houston change, or SBC1's
 * maintenance to SBC2's outage, would send someone to roll back the wrong
 * thing - which is worse than attaching nothing.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now, type ControllableClock } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_WEBEX_TOKEN, directory, HELIX_PLANTED,
  injectFault, mockFetch, resetMockState, TEAMS_PLANTED,
} from './mock/index.ts';
import { createCommsClient, HELIX_TOKEN_TTL_S, TOKEN_HEADROOM_MS, type FetchFn } from './client.ts';
import { arTimestamp, parseArDate, pullOpenTickets, pullRecentChanges, qualification } from './helix.ts';
import { attachHelixContext, contextFor } from './helix-context.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { runCommsPoll } from './poll.ts';
import { commsIncidents } from './store.ts';
import type { CommsIncident } from './incidents.ts';

let clock: ControllableClock;
beforeEach(() => {
  clock = fixedClock();
  setClock(clock);
  resetMockState();
});

function client(fetch: FetchFn = mockFetch) {
  return createCommsClient({
    tenantId: HHS_DEMO_TENANT,
    fetch,
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
      genesys: { ...DEMO_CLIENT },
      webex: { token: DEMO_WEBEX_TOKEN },
      bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER },
    },
    sleep: async () => {},
  });
}

const config = () => COMMS_CONFIG[HHS_DEMO_TENANT];

const incident = (kind: 'facility' | 'trunk' | 'queue', id: string): CommsIncident => ({
  tenantId: HHS_DEMO_TENANT, incidentId: 'i-' + id, title: 't', severity: 'critical',
  subject: { kind, id, name: id }, alarmIds: [], kinds: [], sources: [], localisation: [],
  openedAt: new Date(now()).toISOString(), evidence: [],
});

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

test('qualifications escape values AR\'s way, and refuse field names that are not ours', () => {
  assert.equal(qualification([{ field: 'Site', op: '=', value: 'O"Brien Hall' }]), `'Site' = "O""Brien Hall"`);
  assert.equal(
    qualification([{ field: 'Status', op: '!=', value: 'Closed' }, { field: 'Site', op: '=', value: 'X' }]),
    `'Status' != "Closed" AND 'Site' = "X"`,
  );
  assert.throws(() => qualification([{ field: "Site' OR 'x", op: '=', value: 'y' }]), /refusing field name/);
});

test('an injection attempt in a value stays a value', async () => {
  // Unescaped, this would close the string and add an OR that matches every
  // change. Escaped, it is one odd site name that matches nothing.
  const evil = 'x" OR \'Site\' != "';
  const c = client();
  const url = c.endpoints.helixApi + '/api/arsys/v1/entry/' + encodeURIComponent('CHG:Infrastructure Change') +
    '?' + new URLSearchParams({ q: qualification([{ field: 'Site', op: '=', value: evil }]), fields: 'values(Site)' });
  const body = await (await c.request('helix', url)).json() as { entries: unknown[] };
  assert.equal(body.entries.length, 0);
});

test('AR timestamps with a colon-less offset parse, and garbage throws rather than going NaN', () => {
  assert.equal(parseArDate('2026-09-08T13:35:00.000+0000'), Date.parse('2026-09-08T13:35:00.000Z'));
  assert.equal(parseArDate('2026-09-08T08:35:00.000-0500'), Date.parse('2026-09-08T13:35:00.000Z'));
  assert.equal(parseArDate(null), undefined);
  assert.throws(() => parseArDate('last Tuesday'), /unparseable/);
  assert.equal(parseArDate(arTimestamp(now())), now());
});

test('auth is AR-JWT: the same token under "Bearer" is refused', async () => {
  const login = await mockFetch('https://hhs-restapi.onbmc.example/api/jwt/login', {
    method: 'POST', body: new URLSearchParams({ ...DEMO_HELIX_USER }).toString(),
  });
  const token = (await login.text()).trim();
  const url = 'https://hhs-restapi.onbmc.example/api/arsys/v1/entry/' + encodeURIComponent('HPD:Help Desk') + '?limit=1';
  assert.equal((await mockFetch(url, { headers: { Authorization: 'Bearer ' + token } })).status, 401);
  assert.equal((await mockFetch(url, { headers: { Authorization: 'AR-JWT ' + token } })).status, 200);
});

test('the connector never asks for the submitter\'s name or email', async () => {
  const urls: string[] = [];
  const spy: FetchFn = (input, init) => { urls.push(String(input)); return mockFetch(input, init); };
  await pullOpenTickets(client(spy), now() - 24 * 3600_000);
  const entryCalls = urls.filter((u) => u.includes('/entry/')).map((u) => decodeURIComponent(u));
  assert.ok(entryCalls.length > 0);
  for (const u of entryCalls) {
    assert.match(u, /fields=values\(/);
    assert.doesNotMatch(u, /E-mail|First Name|Last Name/);
  }
});

test('the token is refreshed early, like every other', async () => {
  const c = client();
  await pullRecentChanges(c, now() - 3600_000);
  clock.advance(HELIX_TOKEN_TTL_S * 1000 - TOKEN_HEADROOM_MS + 1);
  await pullRecentChanges(c, now() - 3600_000);
  assert.equal(c.tokenRequests.helix, 2);
});

// ---------------------------------------------------------------------------
// Context on incidents
// ---------------------------------------------------------------------------

test('Houston gets its QoS change and the open ticket - not the old change, not Dallas', async () => {
  const c = client();
  const changes = await pullRecentChanges(c, now() - 24 * 3600_000);
  const tickets = await pullOpenTickets(c, now() - 24 * 3600_000);
  const ctx = contextFor(incident('facility', TEAMS_PLANTED.degradedFacility), changes, tickets, config());

  assert.equal(ctx.status, 'ok');
  assert.deepEqual(ctx.changes.map((x) => x.id), [HELIX_PLANTED.houstonChange]);
  assert.equal(ctx.changes[0].endedMinutesBefore, 14);
  assert.deepEqual(ctx.tickets.map((x) => x.id), [HELIX_PLANTED.houstonTicket]);
});

test('SBC2 gets its certificate renewal, and not SBC1\'s maintenance', async () => {
  const c = client();
  const changes = await pullRecentChanges(c, now() - 24 * 3600_000);
  const ctx = contextFor(incident('trunk', TEAMS_PLANTED.failingTrunk), changes, [], config());
  assert.deepEqual(ctx.changes.map((x) => x.id), [HELIX_PLANTED.sbcChange]);
});

test('a queue gets no context, and says why rather than guessing from ticket text', () => {
  const ctx = contextFor(incident('queue', 'q1'), [], [], config());
  assert.equal(ctx.status, 'no-mapping');
  assert.match(ctx.note!, /Genesys queues/);
});

test('Helix down: context is UNKNOWN, the incidents survive, nothing throws', async () => {
  injectFault('helix', 503, 10);
  const out = await attachHelixContext(client(), config(), [incident('facility', '1120')], now());
  assert.equal(out.length, 1);
  assert.equal(out[0].context?.status, 'unavailable');
  assert.match(out[0].context!.note!, /UNKNOWN, not absent/);
});

test('end to end: the poll stores incidents with their Helix context', async () => {
  const principal: Principal = {
    sub: 't', email: 'ops@hhs.texas.example', tenantId: HHS_DEMO_TENANT,
    roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  await runCommsPoll(principal, client(), config(), now());
  const stored = commsIncidents(principal);
  const houston = stored.find((i) => i.subject.kind === 'facility')!;
  assert.deepEqual(houston.context?.changes.map((c) => c.id), [HELIX_PLANTED.houstonChange]);
  // Context never changes WHETHER something paged: still exactly three.
  assert.equal(stored.length, 3);
});
