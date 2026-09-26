/**
 * The Entra delta sync, pinned against the mock's /users/delta.
 *
 * Each test uses its own tenant id, so its generations and sync state live in
 * their own partitions of the shared stand-in table and cannot leak between
 * cases.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, type ControllableClock } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import { mainTable } from '../../aws/dynamodb.ts';
import {
  DEMO_CLIENT, DEMO_WEBEX_TOKEN, DEMO_BANDWIDTH_USER, DEMO_HELIX_USER, DEMO_KURMI_USER, DELTA_TOKEN_TTL_MS, directory, injectFault, mockFetch,
  mutateEntraUser, removeEntraUser, resetMockState,
} from './mock/index.ts';
import { createCommsClient } from './client.ts';
import { loadEntraDirectory, syncEntraDirectory } from './entra-directory.ts';
import { buildWorkforce } from './workforce.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';

let clock: ControllableClock;
beforeEach(() => {
  clock = fixedClock();
  setClock(clock);
  resetMockState();
});

const principal = (tenantId: string): Principal => ({
  sub: 'test', email: 'ops@hhs.texas.example', tenantId,
  roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
});

const client = (tenantId: string) => createCommsClient({
  tenantId,
  fetch: mockFetch,
  credentials: {
    entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
    genesys: { ...DEMO_CLIENT },
    webex: { token: DEMO_WEBEX_TOKEN },
    bandwidth: { ...DEMO_BANDWIDTH_USER },
    helix: { ...DEMO_HELIX_USER },
    kurmi: { ...DEMO_KURMI_USER },
  },
  sleep: async () => {},
});

/** Every Entra user the mock lists: staff in Teams, plus the two resource accounts. */
const entraCount = () => directory().people.filter((p) => p.inTeams).length + directory().resourceAccounts.length;
const someone = () => directory().people.find((p) => p.inTeams && p.facility)!;

test('a first sync that fits in one run commits the whole directory', async () => {
  const p = principal('t-one-run');
  const r = await syncEntraDirectory(p, client(p.tenantId));
  assert.equal(r.status, 'complete');
  assert.equal(r.mode, 'full');
  const view = loadEntraDirectory(p);
  assert.equal(view.users, entraCount());
  const who = someone();
  assert.deepEqual(view.placementByEmail(who.email.toUpperCase()), { code: who.facility!.code },
    'looked up by address, case-insensitively');
});

test('nothing person-identifying is stored - a hash and a facility code', async () => {
  const p = principal('t-pseudonymous');
  await syncEntraDirectory(p, client(p.tenantId));
  const text = JSON.stringify(mainTable.query({ pk: 'TENANT#' + p.tenantId + '#COMMSDIR' }));
  assert.ok(!text.includes('@'), 'no address at rest');
  assert.ok(!text.includes('Example Pkwy'), 'no street address at rest');
});

test('a first sync longer than one run resumes where it stopped, and readers wait for it', async () => {
  const p = principal('t-resume');
  const c = client(p.tenantId);
  // Three per page puts the directory past the 50-page ceiling - the same
  // shape as 75,000 users at 999 a page.
  const first = await syncEntraDirectory(p, c, { pageSize: 3 });
  assert.equal(first.status, 'first-sync-in-progress');
  assert.equal(first.pages, 50);
  assert.equal(loadEntraDirectory(p).users, 0, 'a half-built directory is never read');

  // While it builds, employees are "not placed YET", not "unplaceable".
  const report = await buildWorkforce(c, COMMS_CONFIG[HHS_DEMO_TENANT], loadEntraDirectory(p));
  assert.ok(report.unplaced.some((u) => u.reason === 'directory-sync-incomplete'));

  const second = await syncEntraDirectory(p, c, { pageSize: 3 });
  assert.equal(second.status, 'complete');
  assert.equal(first.rowsApplied + second.rowsApplied, entraCount(), 'no page fetched twice, none skipped');
  assert.equal(loadEntraDirectory(p).users, entraCount());
});

test('a delta carries only the change, and a partial row does not erase the rest', async () => {
  const p = principal('t-delta');
  const c = client(p.tenantId);
  await syncEntraDirectory(p, c);

  const mover = someone();
  const target = mover.facility!.code === '1120' ? '0412' : '1120';
  mutateEntraUser(mover.ids.entra, { streetAddress: '48 Placeholder St LC=' + target });

  const r = await syncEntraDirectory(p, c);
  assert.equal(r.mode, 'delta');
  assert.equal(r.rowsApplied, 1);
  assert.deepEqual(loadEntraDirectory(p).placementByEmail(mover.email), { code: target });

  // A rename arrives WITHOUT a street address. Merging keeps the facility;
  // overwriting would have made them unplaceable.
  const renamed = 'Renamed.Person@hhs.texas.example';
  mutateEntraUser(mover.ids.entra, { userPrincipalName: renamed });
  await syncEntraDirectory(p, c);
  const view = loadEntraDirectory(p);
  assert.deepEqual(view.placementByEmail(renamed), { code: target });
  assert.equal(view.placementByEmail(mover.email), undefined, 'the old address no longer resolves');
});

test('a removed user is deleted, not left placed', async () => {
  const p = principal('t-remove');
  const c = client(p.tenantId);
  await syncEntraDirectory(p, c);
  const leaver = someone();
  removeEntraUser(leaver.ids.entra);

  const r = await syncEntraDirectory(p, c);
  assert.equal(r.removed, 1);
  const view = loadEntraDirectory(p);
  assert.equal(view.placementByEmail(leaver.email), undefined);
  assert.equal(view.users, entraCount() - 1);
});

test('an expired delta token resyncs into a new generation, serving the old one meanwhile', async () => {
  const p = principal('t-resync');
  const c = client(p.tenantId);
  await syncEntraDirectory(p, c);
  clock.advance(DELTA_TOKEN_TTL_MS + 60_000);

  const r = await syncEntraDirectory(p, c, { pageSize: 3 });
  assert.equal(r.resyncStarted, true);
  assert.equal(r.status, 'resyncing');
  assert.equal(loadEntraDirectory(p).users, entraCount(), 'readers keep the previous generation');

  const done = await syncEntraDirectory(p, c, { pageSize: 3 });
  assert.equal(done.status, 'complete');
  // The old generation is gone: one item per user, not two.
  const items = mainTable.query({ pk: 'TENANT#' + p.tenantId + '#COMMSDIR' });
  assert.equal(items.length, entraCount());
});

test('a failed delta does not advance the link - the change is applied on the next run', async () => {
  const p = principal('t-watermark');
  const c = client(p.tenantId);
  await syncEntraDirectory(p, c);

  const mover = someone();
  const target = mover.facility!.code === '2031' ? '3308' : '2031';
  mutateEntraUser(mover.ids.entra, { streetAddress: '315 Mock Rd LC=' + target });

  injectFault('teams', 500, 3);   // every retry fails
  await assert.rejects(syncEntraDirectory(p, c));
  assert.notDeepEqual(loadEntraDirectory(p).placementByEmail(mover.email), { code: target });

  const r = await syncEntraDirectory(p, c);
  assert.equal(r.rowsApplied, 1, 'the change was not lost with the failed run');
  assert.deepEqual(loadEntraDirectory(p).placementByEmail(mover.email), { code: target });
});

test('mock: only the LAST page of a delta listing carries the deltaLink', async () => {
  const c = client('t-mock');
  const url = c.endpoints.graph + '/users/delta?$select=id,userPrincipalName,streetAddress';
  const first = await (await c.request('teams', url, { headers: { Prefer: 'odata.maxpagesize=10' } })).json() as Record<string, unknown>;
  assert.equal((first.value as unknown[]).length, 10, 'page size comes from the Prefer header');
  assert.ok(first['@odata.nextLink']);
  assert.equal(first['@odata.deltaLink'], undefined);
  assert.ok(!String(first['@odata.nextLink']).includes('$select'), '$select travels inside the token');
});
