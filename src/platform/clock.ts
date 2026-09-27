/**
 * ---------------------------------------------------------------------------
 * The clock, as an injected dependency
 * ---------------------------------------------------------------------------
 * Nothing in this codebase calls `new Date()` or `Date.now()` directly. That
 * looks like ceremony until you need one of the three things it buys:
 *
 *   1. REPRODUCIBLE DEMOS. A run that stamps wall-clock time produces different
 *      output every time, so it cannot be narrated, screenshotted, or diffed
 *      against a previous run to see what a change did.
 *   2. ASSERTABLE TESTS. "The alarm was raised within the batch window" is
 *      only testable if the test controls the window.
 *   3. TRACE REPLAY. The operations board scrubs backwards and forwards through a
 *      recorded observations trace. That is just advancing this clock.
 *
 * The production implementation is `system()` and is what a Lambda uses. The
 * demo and the tests install `fixed()`, which is why every run prints the same
 * timestamps.
 *
 * WHY THIS IS NOT OVER-ENGINEERING: the alternative is `sinon.useFakeTimers()`
 * or monkey-patching global Date, both of which reach behind the code's back.
 * An explicit seam is smaller, has no dependencies, and is honest about the
 * fact that time is an input.
 */

/** Milliseconds since epoch. The only shape the platform passes around. */
export type Millis = number;

export type Clock = {
  /** Current time in millis. */
  now(): Millis;
  /** Current time as ISO-8601 - the form that lands in every record. */
  nowIso(): string;
};

/** Real time. What runs in a Lambda. */
export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };
}

/**
 * A clock you drive by hand.
 *
 * `advance()` is what makes trace replay work: the generated observations trace is
 * a list of ticks, and replaying it is advancing this clock one interval at a
 * time while feeding the matching records through the pipeline.
 */
export type ControllableClock = Clock & {
  setTo(t: Millis | string): void;
  advance(ms: Millis): void;
};

export function fixedClock(start: Millis | string = DEMO_EPOCH): ControllableClock {
  let t = typeof start === 'string' ? Date.parse(start) : start;
  return {
    now: () => t,
    nowIso: () => new Date(t).toISOString(),
    setTo(next) { t = typeof next === 'string' ? Date.parse(next) : next; },
    advance(ms) { t += ms; },
  };
}

/**
 * The instant every demo and test starts from.
 *
 * A Tuesday morning mid-shift, deliberately: dispatch boards are least
 * interesting at 3am, and a trace that starts at midnight looks synthetic.
 */
export const DEMO_EPOCH = Date.parse('2026-09-08T14:30:00.000Z');

/**
 * The ambient clock.
 *
 * Defaults to real time so that importing this module in a Lambda does the
 * obvious thing. `demo.ts` and the test setup call `setClock(fixedClock())`
 * before anything else runs.
 */
let current: Clock = systemClock();

export function setClock(c: Clock): void { current = c; }
export function getClock(): Clock { return current; }

/** The two functions the rest of the codebase actually calls. */
export function now(): Millis { return current.now(); }
export function nowIso(): string { return current.nowIso(); }

/**
 * REAL time, whatever the ambient clock has been set to. For checks against
 * the outside world - a token a real Cognito pool issued - and for nothing
 * that becomes data.
 *
 * WHY IT EXISTS. The demo world pins the ambient clock to DEMO_EPOCH so its
 * output is reproducible, and the board API and the AgentCore agent re-pin it
 * on every request. A real token checked against that clock was "issued in
 * the future" - every request after the first in a warm container failed -
 * and, worse, could never expire: a token from last month looked valid
 * against a clock stuck on 8 September. Determinism is a property of the
 * demo's DATA; the expiry of a credential is a fact about now.
 */
export function wallNow(): Millis { return Date.now(); }
