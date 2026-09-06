/**
 * Transport tests.
 *
 * The board is the third entry point to the same data - after the GraphQL
 * resolvers and the REST handler - and every entry point has to enforce the
 * same boundaries. These run under `node --test` alongside the backend suite,
 * which is only possible because the transport avoids build-time-only features
 * outside the agent path.
 *
 * Rendering is not covered here. React output would need a DOM and would test
 * markup rather than behaviour; what matters is that the board cannot see
 * across a scope boundary and that it shows what the rules decided.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inProcessTransport } from './in-process.ts';

test('a district board shows only that district', async () => {
  const dal = await inProcessTransport.loadBoard('dal');

  assert.ok(dal.drivers.length > 0);
  assert.ok(dal.drivers.every((d) => d.districtId === 'dal'));
  assert.ok(dal.exceptions.every((e) => e.districtId === 'dal'));
  assert.ok(dal.incidents.every((i) => i.districtId === 'dal'));
});

test('two district boards share no drivers', async () => {
  const dal = await inProcessTransport.loadBoard('dal');
  const phx = await inProcessTransport.loadBoard('phx');

  const overlap = dal.drivers
    .map((d) => d.driverId)
    .filter((id) => phx.drivers.some((p) => p.driverId === id));

  assert.equal(overlap.length, 0);
});

test('the lead view is tenant-wide because of the ROLE, not the missing filter', async () => {
  // This is the one that caught a real bug while building the board. A
  // dispatcher with no district claim does NOT get the whole fleet - scope
  // falls back to their own assignments, because widening access has to be a
  // deliberate grant rather than the side effect of an absent field. The
  // all-districts view works only because it signs in as someone entitled to
  // it, and the board came back empty until it did.
  const all = await inProcessTransport.loadBoard(undefined);

  assert.equal(all.drivers.length, 60);
  assert.ok(new Set(all.drivers.map((d) => d.districtId)).size > 1);
});

test('the board shows what the RULES decided, incidents and held-back alike', async () => {
  const all = await inProcessTransport.loadBoard(undefined);

  // Something was escalated...
  assert.ok(all.incidents.length > 0);

  // ...and something was raised and deliberately NOT escalated. The board
  // renders these dimmed rather than hiding them: a dispatcher who can see the
  // noise filter working trusts the board when it is quiet.
  assert.ok(all.heldBack.length > 0, 'the held-back case must be visible somewhere');

  const pagedIds = new Set(all.incidents.flatMap((i) => i.exceptionIds));
  for (const held of all.heldBack) {
    assert.ok(!pagedIds.has(held.exceptionId), 'a held exception must not also be paged');
  }
});

test('Austin is the district where the noise filter is visible', async () => {
  // gps-drift lives here: one exception raised, nobody paged. If this ever
  // starts producing an incident, the corroboration rule has regressed.
  const aus = await inProcessTransport.loadBoard('aus');

  assert.equal(aus.exceptions.length, 1);
  assert.equal(aus.exceptions[0].kind, 'route-deviation');
  assert.equal(aus.incidents.length, 0);
  assert.equal(aus.heldBack.length, 1);
});

test('the live channel delivers only this district, and only exceptions', async () => {
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
  // Every read of it here happened at module scope, so the bundle threw while
  // evaluating and React never rendered: a blank page and one console error
  // pointing at a line that looks completely ordinary.
  //
  // Neither `tsc`, nor the 89 tests, nor `vite build` caught it. A bundler
  // resolves imports; it does not execute module bodies. The only thing that
  // finds this class of bug is running the graph without the globals Node
  // happens to provide, which is what this does.
  const realProcess = globalThis.process;
  const realBuffer = (globalThis as { Buffer?: unknown }).Buffer;

  delete (globalThis as { process?: unknown }).process;
  delete (globalThis as { Buffer?: unknown }).Buffer;

  try {
    // A fresh module graph, so module-scope initialisers actually re-run.
    const url = './in-process.ts?browser-contract=' + Date.now();
    const { inProcessTransport } = await import(url) as typeof import('./in-process.ts');
    const board = await inProcessTransport.loadBoard('dal');

    assert.ok(board.drivers.length > 0);
    assert.ok(board.exceptions.length > 0);
  } finally {
    globalThis.process = realProcess;
    (globalThis as { Buffer?: unknown }).Buffer = realBuffer;
  }
});
