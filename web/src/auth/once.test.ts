/**
 * The callback's exchange runs once per code, however many times the callback
 * does - which is what StrictMode's deliberate double effect needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onceBy } from './once.ts';

test('a second call with the same key shares the first run - result and failure alike', async () => {
  const cache = new Map<string, Promise<string>>();
  let runs = 0;
  // The first run CONSUMES something single-use, as the PKCE state is.
  let stateAvailable = true;
  const exchange = async () => {
    runs++;
    if (!stateAvailable) throw new Error('Sign-in could not be verified. Start again.');
    stateAvailable = false;
    await new Promise((r) => setTimeout(r, 5));
    return 'session';
  };
  const [a, b] = await Promise.all([onceBy(cache, 'code-1|s', exchange), onceBy(cache, 'code-1|s', exchange)]);
  assert.deepEqual([a, b, runs], ['session', 'session', 1], 'the second caller did not re-run, and so did not fail');
});

test('a different key is a different run', async () => {
  const cache = new Map<string, Promise<number>>();
  let runs = 0;
  await onceBy(cache, 'a', async () => ++runs);
  await onceBy(cache, 'b', async () => ++runs);
  assert.equal(runs, 2);
});
