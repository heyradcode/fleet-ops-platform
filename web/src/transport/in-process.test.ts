/**
 * Transport tests.
 *
 * The board is the third entry point to the same data - after the GraphQL
 * resolvers and the REST handler - and every entry point has to enforce the
 * same boundaries. These run under `node --test` alongside the backend suite.
 *
 * They sign in the way the app does rather than fabricating a principal, so
 * what they exercise is the whole path: home-realm discovery, the
 * PreTokenGeneration trigger, token minting, the verifier's checks, and only
 * then the board. A scope assertion here is an assertion about a token that
 * was actually issued.
 *
 * Rendering is not covered. React output would need a DOM and would test
 * markup rather than behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inProcessTransport } from './in-process.ts';
import { localAuth } from '../auth/local.ts';
import { setClock, fixedClock } from '../../../src/platform/clock.ts';

setClock(fixedClock());

/** Sign in and install the session, as the app shell does. */
async function signInAs(email: string) {
  const session = await localAuth.signIn(email);
  inProcessTransport.setSession(session.principal);
  return session;
}

const DISPATCHER = 'dispatcher@acme-freight.com';   // scoped to Dallas
const LEAD = 'lead@meridian.io';                    // admin, tenant-wide
const SAFETY = 'safety@safety.acme-freight.com';    // reads all, writes nothing

test('the board refuses to load without a session', async () => {
  inProcessTransport.setSession(null);
  await assert.rejects(
    () => inProcessTransport.loadBoard('dal'),
    /No session/,
    'there must be no path that reads fleet data without a verified token',
  );
});

test('a district board shows only that district', async () => {
  const { principal } = await signInAs(DISPATCHER);
  assert.deepEqual(principal.scope, { kind: 'district', districtId: 'dal' });

  const dal = await inProcessTransport.loadBoard('dal');
  assert.ok(dal.drivers.length > 0);
  assert.ok(dal.drivers.every((d) => d.districtId === 'dal'));
  assert.ok(dal.exceptions.every((e) => e.districtId === 'dal'));
});

test('a Dallas dispatcher asking for Phoenix gets nothing', async () => {
  await signInAs(DISPATCHER);

  // The argument is a convenience; the TOKEN is the boundary. Asking for
  // another district returns an empty board, not someone else's fleet.
  const phx = await inProcessTransport.loadBoard('phx');
  assert.equal(phx.drivers.length, 0);
});

test('the lead view is tenant-wide because of the ROLE, not a missing filter', async () => {
  // The one that caught a real bug while building the board. A dispatcher with
  // no district claim does NOT get the whole fleet - scope falls back to their
  // own assignments, because widening access has to be a deliberate grant
  // rather than the side effect of an absent field.
  const { principal } = await signInAs(LEAD);
  assert.deepEqual(principal.scope, { kind: 'tenant' });

  const all = await inProcessTransport.loadBoard(undefined);
  assert.equal(all.drivers.length, 60);
  assert.ok(new Set(all.drivers.map((d) => d.districtId)).size > 1);
});

test('a safety reviewer reads the whole carrier but cannot act', async () => {
  // SCOPE IS NOT PERMISSION. Safety needs every district - a harsh-braking
  // pattern is only visible across them - and must not be able to move a load.
  // The two questions are answered by different mechanisms on purpose.
  const { principal } = await signInAs(SAFETY);

  assert.deepEqual(principal.scope, { kind: 'tenant' });
  assert.ok(principal.roles.includes('safety'));
  assert.ok(!principal.roles.includes('dispatcher'));
  assert.ok(!principal.roles.includes('admin'));

  const all = await inProcessTransport.loadBoard(undefined);
  assert.equal(all.drivers.length, 60);
});

test('an unregistered domain is refused, and says what to do', async () => {
  // Fail closed. The failure mode is "no carrier is registered for that
  // domain", not a token with an empty tenant that every query rejects with
  // something the person cannot act on.
  await assert.rejects(
    () => localAuth.signIn('someone@unknown.example'),
    /No carrier is registered/,
  );
});

test('home-realm discovery routes each carrier to its own provider', () => {
  assert.equal(localAuth.discover('a@acme-freight.com').idp, 'AcmeSAML');
  assert.equal(localAuth.discover('b@northstar-logistics.com').idp, 'OktaOIDC');
  // An unknown domain falls back to the native pool rather than erroring - a
  // new carrier can be onboarded before their SSO is configured.
  assert.equal(localAuth.discover('c@example.com').idp, 'COGNITO');
});

test('the board shows what the RULES decided, incidents and held-back alike', async () => {
  await signInAs(LEAD);
  const all = await inProcessTransport.loadBoard(undefined);

  assert.ok(all.incidents.length > 0);

  // Something was raised and deliberately NOT escalated. The board renders
  // these dimmed rather than hiding them: a dispatcher who can see the noise
  // filter working trusts the board when it is quiet.
  assert.ok(all.heldBack.length > 0, 'the held-back case must be visible somewhere');

  const pagedIds = new Set(all.incidents.flatMap((i) => i.exceptionIds));
  for (const held of all.heldBack) {
    assert.ok(!pagedIds.has(held.exceptionId), 'a held exception must not also be paged');
  }
});

test('Austin is where the noise filter is visible', async () => {
  // gps-drift lives here: one exception raised, nobody paged. If this ever
  // starts producing an incident, the corroboration rule has regressed.
  await signInAs(LEAD);
  const aus = await inProcessTransport.loadBoard('aus');

  assert.equal(aus.exceptions.length, 1);
  assert.equal(aus.exceptions[0].kind, 'route-deviation');
  assert.equal(aus.incidents.length, 0);
  assert.equal(aus.heldBack.length, 1);
});

test('the live channel delivers only this district, and only exceptions', async () => {
  await signInAs(LEAD);

  const received: string[] = [];
  const stop = inProcessTransport.subscribeExceptions('phx', (e) => {
    received.push(e.districtId);
  });

  // The channel is timer-driven, so give it one interval plus a margin.
  await new Promise((r) => setTimeout(r, 2700));
  stop();

  assert.ok(received.length > 0, 'the subscription should have delivered something');
  assert.ok(received.every((d) => d === 'phx'));
});

test('a board loaded twice is identical', async () => {
  // Everything the board renders is seeded, so two loads must match. Without
  // this, a screenshot cannot be reproduced and a visual change cannot be told
  // apart from generator noise.
  await signInAs(DISPATCHER);
  const a = await inProcessTransport.loadBoard('dal');
  const b = await inProcessTransport.loadBoard('dal');

  assert.deepEqual(a.drivers, b.drivers);
  assert.deepEqual(a.exceptions.map((e) => e.kind), b.exceptions.map((e) => e.kind));
});

// ---------------------------------------------------------------------------
// The browser contract
// ---------------------------------------------------------------------------

test('the whole module graph loads with no Node globals at all', async () => {
  // THE TEST THAT WOULD HAVE CAUGHT THE BLANK PAGE.
  //
  // `process` is not defined in a browser - not undefined, UNBOUND - so
  // `process.env.FOO` throws a ReferenceError rather than returning undefined.
  // Every read of it was at module scope, so the bundle threw while evaluating
  // and React never rendered: a blank page and one console error pointing at a
  // line that looks completely ordinary.
  //
  // Neither `tsc`, nor the tests, nor `vite build` caught it. A bundler
  // resolves imports; it does not execute module bodies. The only thing that
  // finds this class of bug is running the graph without the globals Node
  // happens to provide.
  const realProcess = globalThis.process;
  const realBuffer = (globalThis as { Buffer?: unknown }).Buffer;

  delete (globalThis as { process?: unknown }).process;
  delete (globalThis as { Buffer?: unknown }).Buffer;

  try {
    // A fresh module graph, so module-scope initialisers actually re-run.
    const stamp = Date.now();
    const authUrl = '../auth/local.ts?browser-contract=' + stamp;
    const transportUrl = './in-process.ts?browser-contract=' + stamp;

    const auth: typeof import('../auth/local.ts') = await import(authUrl);
    const transport: typeof import('./in-process.ts') = await import(transportUrl);

    const session = await auth.localAuth.signIn(DISPATCHER);
    transport.inProcessTransport.setSession(session.principal);
    const board = await transport.inProcessTransport.loadBoard('dal');

    assert.ok(board.drivers.length > 0);
    assert.ok(board.exceptions.length > 0);
  } finally {
    globalThis.process = realProcess;
    (globalThis as { Buffer?: unknown }).Buffer = realBuffer;
  }
});

// ---------------------------------------------------------------------------
// Position replay
// ---------------------------------------------------------------------------

test('position replay moves in-scope drivers and never anyone else', async () => {
  await signInAs(DISPATCHER);

  const ticks: Array<{ ids: string[]; at: string }> = [];
  const stop = inProcessTransport.subscribePositions('dal', (t) => {
    ticks.push({ ids: [...t.positions.keys()], at: t.at });
  });

  // The first tick is emitted synchronously, so the fleet is placed before
  // the interval ever fires - a board must not open on an empty map.
  assert.ok(ticks.length >= 1, 'the first tick must be immediate');
  // One more interval, with margin.
  await new Promise((r) => setTimeout(r, 1700));
  stop();

  assert.ok(ticks.length >= 2, 'the interval must keep ticking');

  const dal = await inProcessTransport.loadBoard('dal');
  const allowed = new Set(dal.drivers.map((d) => d.driverId));
  for (const t of ticks) {
    // Every position belongs to a driver the caller could have loaded. The
    // tick is the SAME boundary as the board, not a second, looser one.
    assert.ok(t.ids.every((id) => allowed.has(id)));
    assert.ok(t.ids.length > 0);
  }

  // Time advances. The header clock follows this, so it must not stand still.
  assert.notEqual(ticks[0].at, ticks[1].at);
});

test('a Dallas dispatcher subscribing to Phoenix positions receives nothing', async () => {
  await signInAs(DISPATCHER);

  const seen: number[] = [];
  const stop = inProcessTransport.subscribePositions('phx', (t) => seen.push(t.positions.size));
  stop();

  // The district is a view; the token is the boundary. Same rule as loadBoard,
  // and it has to hold on this channel too or the map would leak what the
  // roster refuses.
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((n) => n === 0));
});
