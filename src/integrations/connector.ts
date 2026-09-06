/**
 * ---------------------------------------------------------------------------
 * The connector contract
 * ---------------------------------------------------------------------------
 * The JD's first deliverable is "integrate a designated set of third-party APIs
 * into a centralized reporting view". Eight vendors, eight auth schemes, eight
 * payload shapes, eight rate limits. If you write eight bespoke Lambdas you
 * will maintain eight bespoke Lambdas forever.
 *
 * Instead: ONE interface, one retry policy, one circuit breaker, one place that
 * knows how to turn vendor JSON into a `Signal`. Adding Fortinet next quarter
 * is then a new file, not a new architecture.
 *
 *   fetchRaw()   - talk to the vendor. Returns the payload untouched.
 *   normalise()  - vendor payload -> Signal[]. Pure function, trivially unit
 *                  testable, and the ONLY place that understands the vendor.
 *
 * Keeping normalise() pure is what makes replay work: when you find a mapping
 * bug you re-run it over the raw JSON already archived in S3.
 */
import type { ProviderDomain, ProviderId, RawRecord, Signal, TenantId } from '../platform/types.ts';
import { log } from '../platform/logger.ts';

export type ConnectorContext = {
  tenantId: TenantId;
  /** In production these come from Secrets Manager, cached across warm starts. */
  secrets: Record<string, string>;
  /** Only fetch data newer than this - incremental sync, not a full re-pull. */
  since: Date;
};

export type Connector = {
  provider: ProviderId;
  domain: ProviderDomain;
  /** How the vendor authenticates us. Handy for the docs and for debugging. */
  auth: 'api-key-header' | 'oauth2-client-credentials' | 'basic' | 'bearer-token' | 'aws-sigv4';
  /** Vendor's documented rate limit. Feeds the Step Functions Map concurrency. */
  rateLimitPerMin: number;
  fetchRaw(ctx: ConnectorContext): Promise<RawRecord>;
  normalise(raw: RawRecord): Signal[];
};

// ---------------------------------------------------------------------------
// Resilience: retry with jittered backoff, and a circuit breaker
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly status: number;
  /** 429 and 5xx are worth retrying; 401 and 400 never are. */
  readonly retryable: boolean;

  constructor(provider: ProviderId, status: number, message: string) {
    super('[' + provider + '] ' + status + ' ' + message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

/**
 * Exponential backoff with FULL JITTER. The jitter matters: without it, 200
 * Lambdas that were rate-limited at the same instant all retry at the same
 * instant and re-create the exact spike that caused the 429.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 100;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderError && !err.retryable) throw err;
      if (attempt === attempts) break;

      const ceiling = base * Math.pow(2, attempt - 1);
      const delay = Math.random() * ceiling; // full jitter
      log.warn(label + ' attempt ' + attempt + '/' + attempts + ' failed', {
        retryInMs: Math.round(delay),
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Circuit breaker. When a vendor is down, stop calling it: you are burning
 * Lambda duration to collect timeouts, and you are adding load to an outage.
 *
 *   closed    -> normal
 *   open      -> fail instantly, no call made
 *   half-open -> let ONE probe through; success closes, failure re-opens
 */
export class CircuitBreaker {
  #failures = 0;
  #openedAt = 0;
  readonly threshold: number;
  readonly cooldownMs: number;
  readonly name: string;

  constructor(name: string, threshold = 5, cooldownMs = 30_000) {
    this.name = name;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.#failures < this.threshold) return 'closed';
    return Date.now() - this.#openedAt > this.cooldownMs ? 'half-open' : 'open';
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      throw new Error('circuit open for ' + this.name + ' - skipping call, vendor is unhealthy');
    }
    try {
      const out = await fn();
      this.#failures = 0; // success closes the circuit
      return out;
    } catch (err) {
      this.#failures++;
      if (this.#failures === this.threshold) this.#openedAt = Date.now();
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Severity: one rule, applied to every vendor
// ---------------------------------------------------------------------------

/**
 * Vendors disagree about what "critical" means, and half of them do not send a
 * severity at all. So we derive it ourselves from thresholds we control. This
 * is what makes a single cross-vendor reporting view meaningful rather than a
 * pile of incomparable colours.
 */
export function severityFor(kind: Signal['kind'], value: number): Signal['severity'] {
  const thresholds: Record<Signal['kind'], [warning: number, critical: number]> = {
    'device-health': [90, 75],     // inverted: LOWER is worse
    'wan-latency': [120, 250],
    'packet-loss': [1, 5],
    'queue-wait': [60, 180],
    'abandon-rate': [5, 12],
    'agent-occupancy': [85, 95],
    'error-rate': [1, 5],
    'log-volume': [10_000, 50_000],
  };

  const [warn, crit] = thresholds[kind];
  const inverted = kind === 'device-health';

  if (inverted) {
    if (value <= crit) return 'critical';
    if (value <= warn) return 'warning';
    return 'ok';
  }
  if (value >= crit) return 'critical';
  if (value >= warn) return 'warning';
  return 'ok';
}
