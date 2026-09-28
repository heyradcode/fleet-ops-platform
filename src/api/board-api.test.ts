/**
 * The board API: the token is checked on every request, scope bounds every
 * list, and a warm Lambda's answer does not depend on who it served before.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now } from '../platform/clock.ts';
import type { Principal } from '../platform/types.ts';
import {
  auditSnapshot, commsSnapshot, handleBoardApi, seedDemoWorld, type AuditSnapshot, type BoardSnapshot, type CommsSnapshot,
} from './board-api.ts';
import type { ApiGatewayEvent } from './rest-handler.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN,
  directory, mockFetch, resetMockState,
} from '../integrations/comms/mock/index.ts';
import { createCommsClient } from '../integrations/comms/client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from '../integrations/comms/config.ts';
import { runCommsPoll } from '../integrations/comms/poll.ts';

const who = (tenantId: string, roles: Principal['roles'], scope: Principal['scope']): Principal => ({
  sub: 'u-' + tenantId, email: 'u@' + tenantId, tenantId, roles, scope, identityProvider: 'cognito',
});
const DALLAS_OPERATOR = who('acme-networks', ['operator'], { kind: 'site', siteId: 'dal-01' });
const ACME_ADMIN = who('acme-networks', ['admin'], { kind: 'tenant' });
const HHS_LEAD = who(HHS_DEMO_TENANT, ['admin'], { kind: 'tenant' });
const HHS_SITE = who(HHS_DEMO_TENANT, ['operator'], { kind: 'site', siteId: 'hou-01' });

/** The verifier stand-in: a token IS a key into this table, anything else is rejected. */
const TOKENS: Record<string, Principal> = {
  'tok-dallas': DALLAS_OPERATOR, 'tok-acme': ACME_ADMIN, 'tok-hhs': HHS_LEAD, 'tok-hhs-site': HHS_SITE,
};
const verify = async (token: string) => {
  const p = TOKENS[token];
  if (!p) throw new Error('signature does not verify');
  return p;
};

function get(path: string, token?: string, query?: Record<string, string>): ApiGatewayEvent {
  return {
    version: '2.0', routeKey: '$default', rawPath: path,
    headers: token ? { authorization: 'Bearer ' + token } : {},
    queryStringParameters: query,
    requestContext: { requestId: 'r1', http: { method: 'GET', path } },
  };
}

async function call<T>(path: string, token?: string, query?: Record<string, string>) {
  const res = await handleBoardApi(get(path, token, query), { verify });
  return { status: res.statusCode, body: JSON.parse(res.body) as T, headers: res.headers };
}

async function pollHhs() {
  resetMockState();
  setClock(fixedClock());
  await runCommsPoll(HHS_LEAD, createCommsClient({
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
    sleep: async () => {},
  }), COMMS_CONFIG[HHS_DEMO_TENANT], now());
}

beforeEach(() => {
  setClock(fixedClock());
});

test('no token, a malformed header, a bad token: the same 401, and nothing else said', async () => {
  const missing = await call('/board');
  const scheme = await handleBoardApi({ ...get('/board'), headers: { authorization: 'tok-acme' } }, { verify });
  const forged = await call('/board', 'tok-forged');
  for (const r of [missing, { status: scheme.statusCode, body: JSON.parse(scheme.body) }, forged]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { message: 'Unauthorized' }, 'which check failed goes to the log, not the caller');
  }
});

test('the board is bounded by the TOKEN: a Dallas operator gets Dallas, whatever they ask for', async () => {
  const mine = await call<BoardSnapshot>('/board', 'tok-dallas');
  assert.equal(mine.status, 200);
  const sites = new Set([...mine.body.devices, ...mine.body.alarms, ...mine.body.incidents, ...mine.body.heldBack].map((x) => x.siteId));
  assert.deepEqual([...sites], ['dal-01']);

  const austin = await call<BoardSnapshot>('/board', 'tok-dallas', { siteId: 'aus-01' });
  assert.deepEqual([austin.body.devices.length, austin.body.alarms.length, austin.body.heldBack.length], [0, 0, 0]);

  const admin = await call<BoardSnapshot>('/board', 'tok-acme');
  assert.ok(new Set(admin.body.alarms.map((a) => a.siteId)).size > 1, 'the tenant-wide role sees more than one site');
});

test('comms: the lead gets the stored view; a site scope and a network tenant get null', async () => {
  await pollHhs();
  const lead = await call<CommsSnapshot>('/comms', 'tok-hhs');
  assert.equal(lead.status, 200);
  assert.equal(lead.body.incidents.length, 4);
  seedDemoWorld();
  assert.deepEqual(lead.body, JSON.parse(JSON.stringify(await commsSnapshot(HHS_LEAD))), 'the API serves what the tab computes');

  assert.equal((await call('/comms', 'tok-hhs-site')).body, null, 'a site is not a facility');
  assert.equal((await call('/comms', 'tok-acme')).body, null, 'no comms sources, no view');
});

test('a warm container answers the same whoever it served before', async () => {
  await pollHhs();
  const first = await call('/board', 'tok-acme');
  await call('/comms', 'tok-hhs');
  await call('/board', 'tok-hhs');
  const again = await call('/board', 'tok-acme');
  assert.deepEqual(again.body, first.body);
});

test('unknown routes are 404, and per-caller responses are never cached', async () => {
  const r = await call('/devices', 'tok-acme');
  assert.equal(r.status, 404);
  assert.equal((await call('/board', 'tok-acme')).headers['cache-control'], 'no-store');
});

test('audit: an admin reads their own tenant\'s trail; an operator gets null; tenants never mix', async () => {
  const { recordToolCall } = await import('../ai/audit.ts');
  await recordToolCall(DALLAS_OPERATOR, { tool: 'traceTopology', input: { deviceId: 'x' }, outcome: 'ok', ms: 30 });
  await recordToolCall(DALLAS_OPERATOR, { tool: 'traceTopology', input: { deviceId: 'y' }, outcome: 'error', ms: 10 });
  await recordToolCall(ACME_ADMIN, { tool: 'openIncident', input: {}, outcome: 'refused', ms: 0 });
  await recordToolCall(HHS_LEAD, { tool: 'listCommsIncidents', input: {}, outcome: 'ok', ms: 5 });

  const acme = await call<AuditSnapshot>('/audit', 'tok-acme');
  assert.equal(acme.status, 200);
  assert.deepEqual(new Set(acme.body.entries.map((e) => e.sub)), new Set([DALLAS_OPERATOR.sub, ACME_ADMIN.sub]),
    'the admin sees their colleagues\' calls - that is what the trail is for');
  assert.ok(!acme.body.entries.some((e) => e.tool === 'listCommsIncidents'), 'and never another tenant\'s');
  assert.deepEqual(
    { calls: acme.body.summary.calls, ok: acme.body.summary.ok, error: acme.body.summary.error, refused: acme.body.summary.refused },
    { calls: 3, ok: 1, error: 1, refused: 1 },
  );
  assert.deepEqual(acme.body, JSON.parse(JSON.stringify(await auditSnapshot(ACME_ADMIN))), 'the API serves what the tab computes');

  assert.equal((await call('/audit', 'tok-dallas')).body, null, 'an operator is not offered the trail at all');
  assert.equal((await call<AuditSnapshot>('/audit', 'tok-hhs')).body.summary.calls, 1);
});
