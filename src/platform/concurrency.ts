/**
 * Run async work concurrently ACROSS keys and strictly in order WITHIN a key.
 *
 * WHY THIS SHAPE. Against a real table every call is a network round trip -
 * 300 ms from a laptop to us-east-1 - so a loop of a thousand awaits is five
 * minutes of waiting on nothing. But most of those loops are
 * READ-MODIFY-WRITE: a baseline is read, folded and put back; a directory row
 * is read, merged and put back. Two of those on the same key, in parallel,
 * both read the old value and the second write erases the first - a lost
 * update, and no error anywhere. So: items sharing a key run one after
 * another, in their original order; different keys run side by side.
 *
 * Bounded, so a large batch is a steady stream rather than a burst that
 * trips DynamoDB throttling (on-demand tables absorb a lot, not everything).
 *
 * Portable - no Node APIs - because the pipeline code that uses it runs in
 * the browser too.
 */
export async function forEachByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  fn: (item: T) => Promise<void>,
  concurrency = 16,
): Promise<void> {
  // Map preserves insertion order, and each list preserves the items' order.
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    const g = groups.get(k);
    if (g) g.push(item); else groups.set(k, [item]);
  }

  const queue = [...groups.values()];
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const group = queue[next++];
      for (const item of group) await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
}
