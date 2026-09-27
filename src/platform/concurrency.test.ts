/**
 * forEachByKey: parallel across keys, ordered within one - the property that
 * stops a read-modify-write from losing an update.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forEachByKey } from './concurrency.ts';

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

test('a read-modify-write per key never loses an update', async () => {
  const store = new Map<string, number>();
  const items = Array.from({ length: 60 }, (_, i) => ({ key: 'k' + (i % 3), add: 1 }));
  await forEachByKey(items, (i) => i.key, async (i) => {
    const before = store.get(i.key) ?? 0;   // read
    await tick();                           // the round trip
    store.set(i.key, before + i.add);       // write
  });
  assert.deepEqual([...store.entries()].sort(), [['k0', 20], ['k1', 20], ['k2', 20]]);
});

test('within a key, items run in their original order', async () => {
  const seen: number[] = [];
  const items = [5, 1, 4, 2, 3].map((n) => ({ key: 'same', n }));
  await forEachByKey(items, (i) => i.key, async (i) => { await tick(); seen.push(i.n); });
  assert.deepEqual(seen, [5, 1, 4, 2, 3]);
});

test('different keys really do overlap, up to the limit', async () => {
  let running = 0;
  let peak = 0;
  const items = Array.from({ length: 40 }, (_, i) => ({ key: 'k' + i }));
  await forEachByKey(items, (i) => i.key, async () => {
    running++; peak = Math.max(peak, running);
    await tick();
    running--;
  }, 8);
  assert.equal(peak, 8);
});

test('nothing to do is fine', async () => {
  await forEachByKey([], () => 'x', async () => { throw new Error('never'); });
});
