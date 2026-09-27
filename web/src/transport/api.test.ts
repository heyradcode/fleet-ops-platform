/**
 * The API transport, wired straight into the Lambda handler.
 *
 * No network and no Cognito: `fetch` is a function that builds the event API
 * Gateway would and calls handleBoardApi, and the verifier accepts exactly
 * the tokens the local issuer handed out. What that proves is the WIRE -
 * header names, query encoding, status codes - and that switching transports
 * changes where the board is computed, never what it shows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApiTransport, BoardApiError } from './api.ts';
import { inProcessTransport } from './in-process.ts';
import { localAuth } from '../auth/local.ts';
import { setClock, fixedClock } from '../../../src/platform/clock.ts';
import { handleBoardApi } from '../../../src/api/board-api.ts';
import type { Principal } from '../../../src/platform/types.ts';

setClock(fixedClock());

/** Tokens the local issuer handed out -> their principals. The Lambda's verifier, in miniature. */
const issued = new Map<string, Principal>();
let calls = 0;

const handlerFetch: typeof fetch = async (input, init) => {
  calls++;
  const url = new URL(String(input));
  const headers: Record<string, string> = {};
  // API Gateway lower-cases header names; so does this.
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
  const res = await handleBoardApi({
    version: '2.0', routeKey: '$default', rawPath: url.pathname, headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    requestContext: { requestId: 'test', http: { method: init?.method ?? 'GET', path: url.pathname } },
  }, {
    verify: async (token) => {
      const p = issued.get(token);
      if (!p) throw new Error('unknown token');
      return p;
    },
  });
  return new Response(res.body, { status: res.statusCode, headers: res.headers });
};

const api = createApiTransport('https://board-api.test', handlerFetch);

/** Sign in once, and install the session in BOTH transports, as the shell would in each mode. */
async function signInAs(email: string) {
  const session = await localAuth.signIn(email);
  issued.set(session.token, session.principal);
  inProcessTransport.setSession(session.principal);
  api.setSession(session.principal, session.token);
  return session;
}

test('the network board: the same over the API as computed in the tab', async () => {
  for (const [email, siteId] of [['lead@netpulse.io', undefined], ['operator@acme-networks.com', 'dal-01'], ['operator@acme-networks.com', 'aus-01']] as const) {
    await signInAs(email);
    const local = await inProcessTransport.loadBoard(siteId);
    const remote = await api.loadBoard(siteId);
    assert.deepEqual(remote, JSON.parse(JSON.stringify(local)), email + ' ' + siteId);
  }
});

test('the comms view: the store the tab polled, read back over the API', async () => {
  await signInAs('ops-lead@hhs.texas.example');
  const local = await inProcessTransport.loadComms();   // polls into the store first
  const remote = await api.loadComms();
  assert.ok(local && local.incidents.length > 0);
  assert.deepEqual(remote, JSON.parse(JSON.stringify(local)));

  await signInAs('operator@acme-networks.com');
  assert.equal(await api.loadComms(), null, 'a network operator is offered no comms view');
});

test('no session: refused before any request is made', async () => {
  const fresh = createApiTransport('https://board-api.test', handlerFetch);
  const before = calls;
  await assert.rejects(fresh.loadBoard(), /before sign-in/);
  assert.equal(calls, before, 'nothing sent without a token');
});

test('a token the API does not accept says "sign in again", not "broken"', async () => {
  const session = await localAuth.signIn('lead@netpulse.io');
  const t = createApiTransport('https://board-api.test', handlerFetch);
  t.setSession(session.principal, session.token + 'x');
  await assert.rejects(t.loadBoard(), (e: unknown) => e instanceof BoardApiError && /sign in again/.test(e.message));
});

test('a network failure is reported as one', async () => {
  const session = await signInAs('lead@netpulse.io');
  const down = createApiTransport('https://board-api.test', async () => { throw new TypeError('Failed to fetch'); });
  down.setSession(session.principal, session.token);
  await assert.rejects(down.loadBoard(), /did not answer/);
});
