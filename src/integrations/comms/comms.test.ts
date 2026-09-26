/**
 * The comms connectors and the workforce split, against the mocks.
 *
 * Every expected number is computed from the mock directory's GROUND TRUTH,
 * never from the tenant config the code under test reads. See config.ts for
 * why: a test that shares a constant with the code it checks proves only that
 * the constant is the same on both sides.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, type ControllableClock } from '../../platform/clock.ts';
import {
  DEMO_CLIENT, DEMO_WEBEX_TOKEN, DEMO_BANDWIDTH_USER, DEMO_HELIX_USER, directory, injectFault, mockFetch, resetMockState,
} from './mock/index.ts';
import type { Person } from './mock/directory.ts';
import { GRAPH_TOKEN_TTL_S } from './mock/teams.ts';
import { createCommsClient, CommsHttpError, TOKEN_HEADROOM_MS, type CommsCredentials } from './client.ts';
import { buildWorkforce } from './workforce.ts';
import { loadEntraDirectory, syncEntraDirectory } from './entra-directory.ts';
import type { Principal } from '../../platform/types.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import type { CommsTenantConfig } from './types.ts';

let clock: ControllableClock;
let slept: number[];

beforeEach(() => {
  clock = fixedClock();
  setClock(clock);
  resetMockState();
  slept = [];
});

function credentials(): CommsCredentials {
  return {
    entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
    genesys: { ...DEMO_CLIENT },
    webex: { token: DEMO_WEBEX_TOKEN },
    bandwidth: { ...DEMO_BANDWIDTH_USER },
    helix: { ...DEMO_HELIX_USER },
  };
}

function client(creds = credentials()) {
  return createCommsClient({
    tenantId: HHS_DEMO_TENANT,
    fetch: mockFetch,
    credentials: creds,
    sleep: async (ms) => { slept.push(ms); },
  });
}

const config = (): CommsTenantConfig => structuredClone(COMMS_CONFIG[HHS_DEMO_TENANT]);

const PRINCIPAL: Principal = {
  sub: 'test', email: 'ops-lead@hhs.texas.example', tenantId: HHS_DEMO_TENANT,
  roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
};

/** Sync the Entra directory, then build - the order the poll uses. */
async function workforce(c = client(), cfg = config()) {
  await syncEntraDirectory(PRINCIPAL, c);
  return buildWorkforce(c, cfg, loadEntraDirectory(PRINCIPAL));
}

/** Ground truth: group people by a key, the way the split should. */
function countBy(people: Person[], key: (p: Person) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of people) {
    const k = key(p);
    if (k !== undefined) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const agencyKey = (p: Person) => p.agency;
const contractorKey = (p: Person) => p.kind === 'contractor' ? p.email.split('@')[1] : undefined;

// ---------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------

test('workforce: every platform drains completely', async () => {
  const report = await workforce();
  for (const source of ['teams', 'genesys', 'webex'] as const) {
    assert.equal(report.fetched[source]!.truncated, false, source + ' truncated');
    assert.ok(report.fetched[source]!.rows > 0, source + ' returned nothing');
  }
  // Graph and Webex fit in one page at their production page sizes here, so
  // only Genesys (capped at 100) genuinely paginates. The paging dialects
  // themselves are pinned at small page sizes in mock/mock.test.ts.
  assert.ok(report.fetched.genesys!.pages >= 2);
});

test('workforce: per-agency counts match the directory on every platform', async () => {
  const report = await workforce();
  const people = directory().people;

  const teams = people.filter((p) => p.teamsVoice);
  assert.deepEqual(report.byPlatform.teams!.byAgency, countBy(teams, agencyKey));
  assert.equal(report.byPlatform.teams!.excluded.resourceAccounts, 2, 'auto attendant + call queue are not staff');

  const genesys = people.filter((p) => p.inGenesys && p.genesysActive);
  assert.deepEqual(report.byPlatform.genesys!.byAgency, countBy(genesys, agencyKey));
  assert.deepEqual(report.byPlatform.genesys!.contractorsByDomain, countBy(genesys, contractorKey));
  assert.equal(report.byPlatform.genesys!.excluded.inactive,
    people.filter((p) => p.inGenesys && !p.genesysActive).length);

  const webex = people.filter((p) => p.inWebex);
  assert.deepEqual(report.byPlatform.webex!.byAgency, countBy(webex, agencyKey));

  for (const s of Object.values(report.byPlatform)) assert.deepEqual(s!.unknownByDomain, {});
});

test('workforce: the upper-cased domain lands in its agency, not in unknown', async () => {
  const report = await workforce();
  const shouty = directory().people.find((p) => /@[A-Z.]+$/.test(p.email))!;
  const member = report.members.find((m) => m.emailKey === shouty.email.toLowerCase())!;
  assert.deepEqual(member.agency, { kind: 'agency', agency: shouty.agency });
});

test('workforce: facilities match the directory, including via the Entra join', async () => {
  const report = await workforce();
  const people = directory().people;

  const teams = people.filter((p) => p.teamsVoice);
  const expectTeams = countBy(teams, (p) => p.facility?.code);
  const gotTeams = Object.fromEntries(report.byFacility
    .filter((f) => f.counts.teams).map((f) => [f.code, f.counts.teams!]));
  assert.deepEqual(report.byFacility.map((f) => f.code), [...report.byFacility.map((f) => f.code)].sort());
  assert.deepEqual(gotTeams, expectTeams);

  // A Genesys EMPLOYEE has no facility in Genesys, and must still be placed -
  // from their Entra address, whether or not they have a Teams phone.
  const placedAgents = people.filter((p) => p.inGenesys && p.genesysActive && p.kind === 'employee' && p.facility);
  assert.ok(placedAgents.some((p) => !p.teamsVoice), 'the case that needs the full /users pull');
  for (const p of placedAgents) {
    const m = report.members.find((x) => x.emailKey === p.email.toLowerCase())!;
    assert.equal(m.facility?.code, p.facility!.code, p.email);
  }

  assert.deepEqual(report.facilityConflicts, []);
  assert.deepEqual(report.unmappedWebexLocations, []);
});

test('workforce: the unplaceable are reported with the right reason, never guessed', async () => {
  const report = await workforce();
  const reason = (email: string) =>
    report.unplaced.find((u) => u.email.toLowerCase() === email.toLowerCase())?.reason;

  const people = directory().people;
  const typo = people.find((p) => / LC 0412$/.test(p.streetAddress))!;
  assert.equal(reason(typo.email), 'malformed-facility-code');

  const noCode = people.filter((p) => p.kind === 'employee' && !p.facility && !/LC/.test(p.streetAddress));
  const counted = noCode.filter((p) => p.teamsVoice || (p.inGenesys && p.genesysActive) || p.inWebex);
  for (const p of counted) assert.equal(reason(p.email), 'no-facility-code', p.email);

  // Contractors are not in Entra and Genesys holds no facility.
  const contractors = people.filter((p) => p.kind === 'contractor' && p.inGenesys && p.genesysActive);
  for (const p of contractors) assert.equal(reason(p.email), 'no-facility-source', p.email);

  assert.equal(report.unplaced.length, 1 + counted.length + contractors.length);
});

test('workforce: a domain the tenant never listed is counted and named', async () => {
  const cfg = config();
  cfg.contractorDomains = cfg.contractorDomains.filter((d) => d !== 'staffing-co.example');
  const report = await workforce(client(), cfg);
  const expected = directory().people.filter((p) =>
    p.inGenesys && p.genesysActive && p.email.endsWith('@staffing-co.example')).length;
  assert.ok(expected > 0);
  assert.deepEqual(report.byPlatform.genesys!.unknownByDomain, { 'staffing-co.example': expected });
});

test('workforce: a Webex location missing from the table is reported by name', async () => {
  const cfg = config();
  delete cfg.webexLocationFacility['Lubbock'];
  const report = await workforce(client(), cfg);
  const lubbockWebexOnly = directory().people.filter((p) => p.inWebex && p.facility?.code === '3308');
  assert.ok(lubbockWebexOnly.length > 0, 'the table entry must matter for this test to mean anything');
  assert.deepEqual(report.unmappedWebexLocations, ['Lubbock']);
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

test('client: a token is reused, then refreshed EARLY - before it can die mid-drain', async () => {
  const c = client();
  const url = c.endpoints.graph + '/users?$top=1';
  await c.request('teams', url);
  await c.request('teams', url);
  assert.equal(c.tokenRequests.teams, 1);

  // Inside the headroom but not yet expired: refresh now rather than risk a
  // 401 on a later page.
  clock.advance(GRAPH_TOKEN_TTL_S * 1000 - TOKEN_HEADROOM_MS + 1);
  await c.request('teams', url);
  assert.equal(c.tokenRequests.teams, 2);
});

test('client: a 429 waits exactly as long as Retry-After says, then succeeds', async () => {
  const c = client();
  await c.request('genesys', c.endpoints.genesysApi + '/api/v2/users?pageSize=1');
  injectFault('genesys', 429, 1, 3);
  const res = await c.request('genesys', c.endpoints.genesysApi + '/api/v2/users?pageSize=1');
  assert.equal(res.status, 200);
  assert.deepEqual(slept, [3000]);
});

test('client: a Retry-After longer than the ceiling fails instead of parking the run', async () => {
  const c = client();
  injectFault('webex', 429, 1, 120);
  await assert.rejects(c.request('webex', c.endpoints.webexApi + '/locations'),
    (e: unknown) => e instanceof CommsHttpError && e.status === 429);
  assert.deepEqual(slept, []);
});

test('client: bad credentials are a 401 and are not retried', async () => {
  const creds = credentials();
  creds.genesys = { clientId: DEMO_CLIENT.clientId, clientSecret: 'wrong' };
  const c = client(creds);
  await assert.rejects(c.request('genesys', c.endpoints.genesysApi + '/api/v2/users'),
    (e: unknown) => e instanceof CommsHttpError && e.status === 401 && !e.retryable);
  assert.equal(c.tokenRequests.genesys, 1);
  assert.deepEqual(slept, []);
});
