/**
 * ---------------------------------------------------------------------------
 * Randomness, as an injected dependency
 * ---------------------------------------------------------------------------
 * The fourth platform primitive, for the same reason as the clock: a demo whose
 * output changes on every run cannot be narrated, screenshotted, or diffed
 * against the previous run to see what a change actually did.
 *
 * Two callers need it, and it matters that they keep needing REAL randomness in
 * production:
 *
 *   - Retry jitter. Full jitter is a correctness feature, not a cosmetic one:
 *     without it, every client that failed at the same moment retries at the
 *     same moment, and the thundering herd takes the vendor down again. It must
 *     be genuinely random in production and reproducible in a demo.
 *   - The synthetic data generator, which has to produce the same fleet every
 *     run or the scenario tests cannot assert anything about it.
 *
 * mulberry32 is used rather than something stronger because the requirement is
 * "well-distributed and reproducible", not "unpredictable to an adversary".
 * Nothing security-sensitive draws from here - ids come from crypto.ts.
 */

export type Random = () => number;   // [0, 1), like Math.random

/** Real randomness. What runs in a Lambda. */
export const systemRandom: Random = Math.random;

/**
 * A seeded, reproducible generator.
 *
 * mulberry32: 32-bit state, one multiply-xor-shift round. Fast, tiny, and
 * statistically fine for shuffling fixtures and jittering a retry.
 */
export function seededRandom(seed = DEMO_SEED): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed every demo and test run starts from. */
export const DEMO_SEED = 0x4d455249;   // 'MERI'

let current: Random = systemRandom;

export function setRandom(r: Random): void { current = r; }

/** The function the rest of the codebase calls instead of Math.random. */
export function random(): number { return current(); }

/** Convenience: pick one element. Returns undefined for an empty array. */
export function pick<T>(items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[Math.floor(random() * items.length)];
}
