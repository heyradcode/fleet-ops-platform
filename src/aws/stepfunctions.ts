/**
 * ---------------------------------------------------------------------------
 * Step Functions - orchestration you can watch
 * ---------------------------------------------------------------------------
 * Use Step Functions when a workflow (a) has more than ~2 steps, (b) needs
 * per-step retry/branching, or (c) can outlive a 15-minute Lambda. Use plain
 * Lambda + EventBridge when the steps are genuinely independent.
 *
 * Two flavours, and you will be asked which and why:
 *   STANDARD - exactly-once, up to 1 year, full visual execution history,
 *              priced per state transition. Use for the scheduled ingest.
 *   EXPRESS  - at-least-once, max 5 min, priced per GB-second (~orders of
 *              magnitude cheaper at high volume), logs to CloudWatch instead
 *              of execution history. Use for per-API-request orchestration.
 *
 * The deployable definition is Amazon States Language JSON - see
 * src/pipeline/state-machine.asl.json, which mirrors this executor state
 * for state. This class exists so the pipeline runs in your terminal.
 */
import { log, out } from '../platform/logger.ts';

export type TaskFn<I, O> = (input: I) => Promise<O> | O;
export type RetryPolicy = { maxAttempts: number; intervalMs: number; backoffRate: number };

export type State =
  | { type: 'Task'; name: string; fn: TaskFn<any, any>; retry?: RetryPolicy; onError?: 'fail' | 'continue' }
  | { type: 'Map'; name: string; items: (input: any) => any[]; iterator: TaskFn<any, any>; maxConcurrency: number }
  | { type: 'Choice'; name: string; branches: Array<{ when: (i: any) => boolean; then: State[] }>; otherwise?: State[] }
  | { type: 'Pass'; name: string; transform: (i: any) => any };

export class StateMachine {
  readonly name: string;
  #states: State[];
  /** Every state transition, for the execution-history printout. */
  readonly history: Array<{ state: string; type: string; ms: number; note?: string }> = [];

  constructor(name: string, states: State[]) {
    this.name = name;
    this.#states = states;
  }

  async start(input: unknown): Promise<any> {
    log.info('StartExecution ' + this.name);
    return this.#run(this.#states, input);
  }

  async #run(states: State[], input: any): Promise<any> {
    let current = input;
    for (const state of states) {
      const t0 = performance.now();

      if (state.type === 'Task') {
        current = await this.#withRetry(state, current);
      } else if (state.type === 'Map') {
        // Map = fan-out. maxConcurrency is the knob that stops your own
        // parallelism from rate-limiting the third-party API you are calling.
        const items = state.items(current);
        const out: any[] = [];
        for (let i = 0; i < items.length; i += state.maxConcurrency) {
          const batch = items.slice(i, i + state.maxConcurrency);
          out.push(...await Promise.all(batch.map((it) => state.iterator(it))));
        }
        current = out;
      } else if (state.type === 'Choice') {
        const hit = state.branches.find((b) => b.when(current));
        this.history.push({ state: state.name, type: 'Choice', ms: 0, note: hit ? 'matched' : 'default' });
        current = await this.#run(hit ? hit.then : state.otherwise ?? [], current);
        continue;
      } else {
        current = state.transform(current);
      }

      this.history.push({ state: state.name, type: state.type, ms: Math.round(performance.now() - t0) });
    }
    return current;
  }

  /** ASL "Retry" with exponential backoff, plus "Catch" to keep going. */
  async #withRetry(state: Extract<State, { type: 'Task' }>, input: any): Promise<any> {
    const policy = state.retry ?? { maxAttempts: 1, intervalMs: 0, backoffRate: 1 };
    let wait = policy.intervalMs;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      try {
        return await state.fn(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === policy.maxAttempts) {
          if (state.onError === 'continue') {
            log.warn(state.name + ' failed permanently, Catch -> continue', { error: msg });
            return input;
          }
          throw err;
        }
        log.warn(state.name + ' attempt ' + attempt + ' failed, retry in ' + wait + 'ms', { error: msg });
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.round(wait * policy.backoffRate);
      }
    }
  }

  printHistory(): void {
    for (const h of this.history) {
      const bar = '#'.repeat(Math.min(20, Math.ceil(h.ms / 5)));
      const line = '   \x1b[90m' + h.type.padEnd(6) + '\x1b[0m ' + h.state.padEnd(24) +
        ' \x1b[32m' + bar + '\x1b[0m \x1b[90m' + h.ms + 'ms ' + (h.note ?? '') + '\x1b[0m\n';
      out(line);
    }
  }
}
