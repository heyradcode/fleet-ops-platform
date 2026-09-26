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

const OPERATOR = 'operator@acme-networks.com';   // scoped to Dallas
const LEAD = 'lead@netpulse.io';                 // admin, tenant-wide
const ENGINEER = 'e@eng.acme-networks.com';      // reads all, writes nothing

test('the board refuses to load without a session', async () => {
  inProcessTransport.setSession(null);
  await assert.rejects(
    () => inProcessTransport.loadBoard('dal-01'),
    /must not render before sign-in/,
  );
});

test('a site board shows only that site', async () => {
  await signInAs(OPERATOR);
  const board = await inProcessTransport.loadBoard('dal-01');

  assert.ok(board.devices.length > 0);
  assert.ok(board.devices.every((d) => d.siteId === 'dal-01'));
});

test('a Dallas operator asking for Phoenix gets nothing', async () => {
  await signInAs(OPERATOR);
  const board = await inProcessTransport.loadBoard('phx-01');

  // The site is a VIEW; the token is the BOUNDARY. Scope already excluded
  // Phoenix, so asking for it explicitly returns an empty board rather than
  // Dallas's devices under a Phoenix heading.
  assert.equal(board.devices.length, 0);
});

test('the lead view is tenant-wide because of the ROLE, not a missing filter', async () => {
  await signInAs(LEAD);
  const board = await inProcessTransport.loadBoard();

  const sites = new Set(board.devices.map((d) => d.siteId));
  assert.ok(sites.size > 1, 'an admin sees more than one site');

  // And it is the token that says so, not the absence of an argument.
  const session = await localAuth.signIn(LEAD);
  assert.equal(session.principal.scope.kind, 'tenant');
});

test('an engineer reads the whole estate but cannot act', async () => {
  const session = await signInAs(ENGINEER);
  const board = await inProcessTransport.loadBoard();

  assert.equal(session.principal.scope.kind, 'tenant');
  assert.ok(new Set(board.devices.map((d) => d.siteId)).size > 1);

  // SCOPE IS NOT PERMISSION. Reading the estate is what the job needs; the
  // write tools are a separate check and this role does not pass it.
  const { canUseTool } = await import('../../../src/ai/guardrails.ts');
  assert.ok(!canUseTool(session.principal, 'openIncident').allowed);
});

test('an unregistered domain is refused, and says what to do', async () => {
  await assert.rejects(
    () => localAuth.signIn('nobody@example.com'),
    /registered|no tenant|unknown/i,
  );
});

test('home-realm discovery routes each customer to its own provider', async () => {
  const { resolveIdpForEmail } = await import('../../../src/auth/providers.ts');
  assert.equal(resolveIdpForEmail(OPERATOR), 'AcmeSAML');
  assert.equal(resolveIdpForEmail('x@northwind-utilities.com'), 'OktaOIDC');
  assert.equal(resolveIdpForEmail('x@example.com'), 'COGNITO');
});

test('the board shows what the RULES decided, incidents and held-back alike', async () => {
  await signInAs(LEAD);
  const board = await inProcessTransport.loadBoard();

  assert.ok(board.alarms.length > 0, 'the scenarios must raise alarms');
  assert.ok(board.incidents.length > 0, 'and some must corroborate into incidents');

  // Every incident's alarms are accounted for, and the held-back set is
  // exactly the complement. If these overlapped, the board would be showing
  // the same alarm as both paged and suppressed.
  const paged = new Set(board.incidents.flatMap((i) => i.alarmIds));
  assert.ok(board.heldBack.every((a) => !paged.has(a.alarmId)));
});

test('the noise filter is visible on the board, not hidden by it', async () => {
  await signInAs(LEAD);
  const board = await inProcessTransport.loadBoard();

  // The lone-signal scenario exists precisely so something lands here. A board
  // that hid uncorroborated alarms would be indistinguishable from one whose
  // rules were broken.
  assert.ok(board.heldBack.length > 0, 'an uncorroborated alarm must still be shown');
});

test('the live channel delivers only this site, and only alarms', async () => {
  await signInAs(OPERATOR);

  const received: string[] = [];
  const stop = inProcessTransport.subscribeAlarms('dal-01', (a) => received.push(a.siteId));
  await new Promise((r) => setTimeout(r, 2600));
  stop();

  assert.ok(received.every((s) => s === 'dal-01'));
});

test('a board loaded twice is identical', async () => {
  await signInAs(OPERATOR);
  const a = await inProcessTransport.loadBoard('dal-01');
  const b = await inProcessTransport.loadBoard('dal-01');

  assert.deepEqual(a.devices, b.devices);
  assert.deepEqual(a.alarms.map((x) => x.kind), b.alarms.map((x) => x.kind));
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

  // The runbooks come off disk here, since there is no Vite bundle. Loaded
  // BEFORE the globals go, because reading files needs Node.
  const { loadRunbooksFromDisk } = await import('../../../src/platform/runbook-loader.node.ts');
  loadRunbooksFromDisk();

  delete (globalThis as { process?: unknown }).process;
  delete (globalThis as { Buffer?: unknown }).Buffer;

  try {
    // A fresh module graph, so module-scope initialisers actually re-run.
    const stamp = Date.now();
    const authUrl = '../auth/local.ts?browser-contract=' + stamp;
    const transportUrl = './in-process.ts?browser-contract=' + stamp;

    const auth: typeof import('../auth/local.ts') = await import(authUrl);
    const transport: typeof import('./in-process.ts') = await import(transportUrl);

    const session = await auth.localAuth.signIn(OPERATOR);
    transport.inProcessTransport.setSession(session.principal);
    const board = await transport.inProcessTransport.loadBoard('dal-01');

    assert.ok(board.devices.length > 0);
    assert.ok(board.alarms.length > 0);

    // THE SECOND TIME. Loading the graph proved nothing about what it does
    // when it RUNS: the agent's first log line reached process.stdout and the
    // device panel showed "process is not defined" under a working map. So
    // exercise the deepest path - tools, retrieval, the model loop - with the
    // globals still gone.
    const result = await transport.inProcessTransport.askAgent(
      'A switch port at dal-01 keeps flapping. Is this real, and what should I do?',
    );
    assert.ok(result.answer.length > 0);
    assert.ok(result.trace.some((t) => t.kind === 'tool'));
  } finally {
    globalThis.process = realProcess;
    (globalThis as { Buffer?: unknown }).Buffer = realBuffer;
  }
});

// ---------------------------------------------------------------------------
// Health replay
// ---------------------------------------------------------------------------

test('health replay advances time and never names an out-of-scope device', async () => {
  await signInAs(OPERATOR);

  const ticks: Array<{ ids: string[]; at: string }> = [];
  const stop = inProcessTransport.subscribeHealth('dal-01', (t) => {
    ticks.push({ ids: [...t.status.keys()], at: t.at });
  });

  // The first frame is emitted synchronously, so the estate is drawn before
  // the interval ever fires - a board must not open blank.
  assert.ok(ticks.length >= 1, 'the first frame must be immediate');
  await new Promise((r) => setTimeout(r, 1700));
  stop();

  assert.ok(ticks.length >= 2, 'the interval must keep ticking');

  const dal = await inProcessTransport.loadBoard('dal-01');
  const allowed = new Set(dal.devices.map((d) => d.deviceId));
  for (const t of ticks) {
    // Every device named in a frame is one the caller could have loaded. The
    // frame is the SAME boundary as the board, not a second, looser one.
    assert.ok(t.ids.every((id) => allowed.has(id)));
  }

  // Time advances. The header clock follows this, so it must not stand still.
  assert.notEqual(ticks[0].at, ticks[1].at);
});

test('a Dallas operator subscribing to Phoenix health receives nothing', async () => {
  await signInAs(OPERATOR);

  const seen: number[] = [];
  const stop = inProcessTransport.subscribeHealth('phx-01', (t) => seen.push(t.status.size));
  stop();

  // The site is a view; the token is the boundary. Same rule as loadBoard, and
  // it has to hold on this channel too or the map would leak what the device
  // list refuses.
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((n) => n === 0));
});

// ---------------------------------------------------------------------------
// The comms view
// ---------------------------------------------------------------------------

const HHS_LEAD = 'ops-lead@hhs.texas.example';   // admin, tenant hhs-demo

test('comms: an HHS lead gets the comms view, with the planted incidents', async () => {
  await signInAs(HHS_LEAD);
  const comms = await inProcessTransport.loadComms();
  assert.ok(comms, 'a comms tenant, tenant-wide, must get the view');
  assert.deepEqual(comms.incidents.map((i) => i.subject.kind).sort(), ['facility', 'queue', 'trunk']);
  assert.ok(comms.workforce.byFacility.length > 0);
});

test('comms: the snapshot carries counts, never a person', async () => {
  await signInAs(HHS_LEAD);
  const comms = await inProcessTransport.loadComms();
  assert.ok(!JSON.stringify(comms).includes('@'), 'no email address reaches the board');
});

test('comms: network-only tenants get null - no view to offer, not an empty one', async () => {
  for (const email of [OPERATOR, LEAD, ENGINEER]) {
    await signInAs(email);
    assert.equal(await inProcessTransport.loadComms(), null, email);
  }
});

test('comms: the HHS lead\'s assistant is offered the comms tools', async () => {
  await signInAs(HHS_LEAD);
  await inProcessTransport.loadComms();
  const result = await inProcessTransport.askAgent('Why is call quality bad in Houston?');
  const tools = result.trace.filter((t) => t.kind === 'tool').map((t) => t.detail.split('(')[0]);
  assert.ok(tools.includes('listCommsIncidents'), tools.join(', '));
});
