/**
 * ---------------------------------------------------------------------------
 * The connector contract
 * ---------------------------------------------------------------------------
 * Every vendor integration is one of these. Three clouds today - Meraki, Mist,
 * Aruba Central - and adding a fourth is a new file plus a line in the
 * registry, not a new architecture.
 *
 * TWO DIRECTIONS, ONE CONNECTOR. Both are the vendor's cloud HTTP API; they
 * differ only in who initiates:
 *
 *   poll()      we call them on a schedule. Complete, ordered, late.
 *   onWebhook() they call us the moment something happens. Timely, partial,
 *               unordered, and occasionally delivered twice.
 *
 * Keeping both on one object is deliberate. They return the SAME observations
 * from the SAME vendor's vocabulary, and splitting them into two files means
 * two places that decode a Meraki alert type - which drift, and then the board
 * shows a different severity depending on whether the news arrived by poll or
 * by push.
 *
 * WHY BOTH RATHER THAN JUST WEBHOOKS: a webhook that is never delivered is
 * invisible. There is no gap to notice, no error, no retry you can see - the
 * event simply never existed as far as this platform is concerned. The poll is
 * the reconciling sweep that eventually catches what the push dropped, which is
 * why its watermark overlaps rather than abuts. See `sinceFor` in http.ts.
 *
 * `normalise` is PURE in both directions. That is what makes replay work: when
 * you find a mapping bug you re-run it over the JSON already archived in S3,
 * and cloud APIs make that matter more than it used to - most of them retain a
 * rolling window, so a re-fetch to recover from a bug is often impossible.
 */
import type {
  Observation, ObservationPlane, PlatformId, TenantId, VendorId,
} from '../platform/types.ts';
import type { Inventory } from '../platform/inventory.ts';
import type { HttpPage, PageCursor, RawBatch } from './http.ts';
import { log } from '../platform/logger.ts';
import { random } from '../platform/random.ts';

/**
 * The pollers this platform knows how to talk to: three vendor clouds, and
 * SolarWinds Orion - an on-premises poller that watches every vendor.
 */
export type ControllerId = 'meraki' | 'mist' | 'aruba-central' | 'solarwinds';

/**
 * One endpoint on one cloud.
 *
 * The axis that replaced `encoding` when the UDP feeds went away. A cloud is
 * not one shape - Meraki's device-statuses endpoint and its alerts endpoint
 * return different JSON, move at different rates, and (the part that matters)
 * observe from different PLANES. So the unit of mapping is the resource, not
 * the vendor.
 */
export type Resource = {
  /** Stable name. Appears in the S3 key and in the watermark, so do not rename. */
  name: string;
  /** Where this endpoint's knowledge comes from. See ObservationPlane. */
  plane: ObservationPlane;
  /** Cursor to start a cold fetch from. */
  firstPage(ctx: ConnectorContext): PageCursor;
  /** One page. The connector owns the vendor's pagination dialect. */
  fetchPage(ctx: ConnectorContext, cursor: PageCursor): Promise<HttpPage>;
};

export type ConnectorContext = {
  tenantId: TenantId;
  /** In production these come from Secrets Manager, cached across warm starts. */
  secrets: Record<string, string>;
  /**
   * Only fetch what changed since this.
   *
   * Derived from the persisted watermark with a deliberate overlap, NOT from
   * "now minus the poll interval" - a run that is late, retried, or recovering
   * from an outage would otherwise skip precisely the window it was late for.
   */
  since: Date;
};

export type Connector = {
  controller: ControllerId;
  /**
   * Descriptive only - the pipeline never reads it. A multi-vendor poller
   * (SolarWinds) says so; its observations carry each DEVICE's real vendor.
   */
  vendor: VendorId | 'multi-vendor';
  platform: PlatformId | 'solarwinds-orion';
  /** How the vendor authenticates us. Handy for the docs and for debugging. */
  auth: 'api-key-header' | 'oauth2-client-credentials' | 'basic' | 'bearer-token';
  /**
   * Vendor's documented rate limit, in requests per minute.
   *
   * Feeds the Step Functions Map concurrency. It is per ORGANISATION, not per
   * caller, so every tenant on the same customer's account shares it - which is
   * why the poll interval is a product decision and not a tuning knob.
   */
  rateLimitPerMin: number;
  /** The endpoints this connector polls. */
  resources: Resource[];
  /**
   * Vendor payload -> Observation[]. Pure, and the ONLY place that understands
   * this cloud's JSON.
   *
   * Takes the inventory because the cloud has its own device ids and nothing
   * downstream may key on a vendor string; takes the resource because the plane
   * and the shape both depend on which endpoint the rows came from.
   */
  normalise(raw: RawBatch, inventory: Inventory, resource: Resource): Observation[];
  /**
   * An inbound alert from this vendor's webhook, already signature-verified.
   *
   * Optional: a cloud that does not push is still a perfectly good connector,
   * it is just a slower one. Returning [] for an alert type you do not handle
   * is the normal case - these feeds carry a great deal that is not
   * operationally interesting.
   */
  onWebhook?(raw: RawBatch, inventory: Inventory): Observation[];
};

// ---------------------------------------------------------------------------
// Resilience: retry with jittered backoff, and a circuit breaker
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  readonly controller: ControllerId;
  readonly status: number;
  /**
   * 429 and 5xx are worth retrying; 401 and 400 never are.
   *
   * 403 is the interesting one and it is NOT retryable: on these APIs it
   * usually means the token is valid but the scope is wrong, which no amount
   * of waiting fixes and which a retry loop turns into a lockout.
   */
  readonly retryable: boolean;

  constructor(controller: ControllerId, status: number, message: string) {
    super('[' + controller + '] ' + status + ' ' + message);
    this.name = 'ProviderError';
    this.controller = controller;
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
      const delay = random() * ceiling; // full jitter
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
 * Circuit breaker. When a cloud is down, stop calling it: you are burning
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
      throw new Error('circuit open for ' + this.name + ' - skipping call, cloud is unhealthy');
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
