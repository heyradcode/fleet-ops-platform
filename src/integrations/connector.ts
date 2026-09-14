/**
 * ---------------------------------------------------------------------------
 * The controller connector contract - and why this file is not wire.ts
 * ---------------------------------------------------------------------------
 * The estate has two halves that arrive completely differently, and pretending
 * otherwise is what forces a UDP listener into a Lambda that cannot hold a
 * socket.
 *
 *   PUSH   syslog, SNMP traps, gNMI, IPFIX. Devices send at us, over UDP or
 *          gRPC, into a persistent collector. See wire.ts - decoder per
 *          encoding, mapper per vendor.
 *   PULL   Meraki, Mist, Aruba Central. Cloud controllers with REST APIs and
 *          webhooks, polled on a schedule. THIS file.
 *
 * The pull half keeps the shape a fleet platform would use, because the shape
 * genuinely fits: `fetchRaw` talks to the vendor, `normalise` turns the reply
 * into observations, and both live on one object because the same code owns the
 * whole round trip. Splitting decode from map buys nothing here - the payload
 * is already JSON, so "decoding" is a no-op, and there is no shared framing
 * between Meraki and Mist for a shared decoder to own.
 *
 * WHY BOTHER WITH THE PULL HALF AT ALL, given the devices already tell us what
 * happened? Because a controller is an INDEPENDENT OBSERVATION PLANE. A switch
 * reporting its own link failure by syslog and by trap is one witness talking
 * twice; the controller noticing the same switch stopped checking in is a
 * genuinely separate vantage point. Corroboration needs that, and in the worst
 * case - a device wedged or powered off, reporting nothing at all - the
 * controller and the external probe are the only things left. See
 * `ObservationPlane` in platform/types.ts.
 *
 * Keeping normalise() pure is what makes replay work: when you find a mapping
 * bug you re-run it over the raw JSON already archived in S3.
 */
import type {
  Observation, PlatformId, TenantId, VendorId,
} from '../platform/types.ts';
import type { Inventory } from '../platform/inventory.ts';
import type { RawBatch } from './wire.ts';
import { log } from '../platform/logger.ts';
import { random } from '../platform/random.ts';

/** The three cloud-managed estates this platform knows how to poll. */
export type ControllerId = 'meraki' | 'mist' | 'aruba-central';

export type ConnectorContext = {
  tenantId: TenantId;
  /** In production these come from Secrets Manager, cached across warm starts. */
  secrets: Record<string, string>;
  /** Only fetch data newer than this - incremental sync, not a full re-pull. */
  since: Date;
};

export type Connector = {
  controller: ControllerId;
  vendor: VendorId;
  platform: PlatformId;
  /** How the vendor authenticates us. Handy for the docs and for debugging. */
  auth: 'api-key-header' | 'oauth2-client-credentials' | 'basic' | 'bearer-token' | 'aws-sigv4';
  /** Vendor's documented rate limit. Feeds the Step Functions Map concurrency. */
  rateLimitPerMin: number;
  fetchRaw(ctx: ConnectorContext): Promise<RawBatch>;
  /**
   * Controller payload -> Observation[]. Pure, and the ONLY place that
   * understands this controller's JSON.
   *
   * Takes the inventory for the same reason the push mappers do: the controller
   * has its own device ids, and nothing downstream may key on a vendor string.
   */
  normalise(raw: RawBatch, inventory: Inventory): Observation[];
};

// ---------------------------------------------------------------------------
// Resilience: retry with jittered backoff, and a circuit breaker
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  readonly controller: ControllerId;
  readonly status: number;
  /** 429 and 5xx are worth retrying; 401 and 400 never are. */
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
 * Circuit breaker. When a controller is down, stop calling it: you are burning
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
      throw new Error('circuit open for ' + this.name + ' - skipping call, controller is unhealthy');
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
