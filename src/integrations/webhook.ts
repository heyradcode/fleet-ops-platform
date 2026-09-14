/**
 * ---------------------------------------------------------------------------
 * Inbound webhooks: the other half of "cloud HTTP"
 * ---------------------------------------------------------------------------
 * Polling every five minutes means a link failure is on the board somewhere
 * between zero and five minutes after it happened, averaging two and a half.
 * For a NOC that is poor: the whole value of the product is telling someone
 * before the calls start, and an outage has usually been noticed by a human in
 * under two minutes.
 *
 * So the clouds push too. Meraki, Mist and Aruba Central all POST alerts to an
 * HTTPS endpoint you register, and that is still a cloud HTTP API - just the
 * inbound direction. Polling stays as the reconciling sweep, because webhooks
 * are best-effort and a dropped delivery is invisible; the poll is what
 * eventually notices what the webhook lost.
 *
 * THREE THINGS A WEBHOOK NEEDS THAT A POLL DOES NOT, and all three are security
 * or correctness rather than plumbing:
 *
 *   1. SIGNATURE VERIFICATION. The endpoint is on the public internet and its
 *      URL is not a secret. Without an HMAC check, anyone who learns the URL
 *      can inject alarms into a customer's estate - or, worse, inject a
 *      link-UP for a device that is actually down and clear a real incident.
 *   2. A REPLAY WINDOW. A valid signature stays valid forever. Capture one
 *      delivery and you can resend it indefinitely unless the timestamp is
 *      signed AND checked against now.
 *   3. IDEMPOTENCY. Every one of these vendors retries on a non-2xx, and at
 *      least one retries on a slow 2xx. The same alert WILL arrive twice.
 *
 * The platform already solves (3) for free: `observationId` is a content hash,
 * so a duplicate delivery overwrites its own row. (1) and (2) are this file.
 */
import { hmacSha256, timingSafeEqual, b64urlDecode, toHex } from '../platform/crypto.ts';
import { now } from '../platform/clock.ts';
import { log } from '../platform/logger.ts';
import type { TenantId } from '../platform/types.ts';
import type { RawBatch } from './http.ts';

export type WebhookRequest = {
  /** The raw body, EXACTLY as received. See verifySignature. */
  body: string;
  headers: Record<string, string>;
};

export type WebhookVerdict =
  | { ok: true; batch: RawBatch }
  | { ok: false; status: 401 | 400 | 408; reason: string };

/**
 * How far out of step a delivery's timestamp may be.
 *
 * Five minutes each way. Tight enough that a captured delivery is useless
 * within one coffee break; loose enough to survive ordinary clock drift on
 * either side and a vendor's own retry backoff, which can be minutes.
 */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Each vendor signs differently, so the shared part is the CHECKING and the
 * per-vendor part is where to find the pieces.
 */
export type WebhookScheme = {
  vendor: string;
  /** Header carrying the hex or base64url HMAC. */
  signatureHeader: string;
  /** Header carrying the signed timestamp, when the vendor sends one. */
  timestampHeader?: string;
  /**
   * What actually gets signed. Meraki signs the body alone; a scheme that signs
   * `timestamp + '.' + body` is what makes the replay check meaningful, because
   * otherwise the timestamp is unauthenticated and an attacker can just edit it.
   */
  signedPayload(req: WebhookRequest): string;
  encoding: 'hex' | 'base64url';
};

export const SCHEMES: Record<string, WebhookScheme> = {
  meraki: {
    vendor: 'cisco',
    signatureHeader: 'x-cisco-meraki-signature',
    timestampHeader: 'x-cisco-meraki-timestamp',
    // Timestamp inside the signed payload, so it cannot be edited in flight.
    signedPayload: (r) => (r.headers['x-cisco-meraki-timestamp'] ?? '') + '.' + r.body,
    encoding: 'hex',
  },
  mist: {
    vendor: 'juniper',
    signatureHeader: 'x-mist-signature-v2',
    timestampHeader: 'x-mist-timestamp',
    signedPayload: (r) => (r.headers['x-mist-timestamp'] ?? '') + '.' + r.body,
    encoding: 'hex',
  },
  'aruba-central': {
    vendor: 'aruba',
    signatureHeader: 'x-central-signature',
    timestampHeader: 'x-central-timestamp',
    signedPayload: (r) => (r.headers['x-central-timestamp'] ?? '') + '.' + r.body,
    encoding: 'hex',
  },
};

/**
 * Verify and unwrap one delivery.
 *
 * ORDER MATTERS: signature BEFORE timestamp, and both before JSON.parse. Check
 * the timestamp first and you have told an unauthenticated caller whether their
 * guessed timestamp was in range. Parse first and you are running a JSON
 * parser on unauthenticated input, which is a strictly larger attack surface
 * than an HMAC comparison.
 */
export function verifyWebhook(
  controller: string,
  req: WebhookRequest,
  secret: string,
  tenantId: TenantId,
): WebhookVerdict {
  const scheme = SCHEMES[controller];
  if (!scheme) return { ok: false, status: 400, reason: 'unknown controller ' + controller };

  const presented = req.headers[scheme.signatureHeader];
  if (!presented) return { ok: false, status: 401, reason: 'no signature header' };

  // THE BODY MUST BE THE RAW BYTES. Re-serialising parsed JSON changes key
  // order and whitespace, the HMAC no longer matches, and the symptom is
  // "every webhook is rejected as forged" pointing at a signature check that is
  // completely correct. API Gateway proxy integration gives you the raw string;
  // keep it that way all the way to here.
  const expected = hmacSha256(secret, scheme.signedPayload(req));
  const actual = decodeSignature(presented, scheme.encoding);

  if (!actual || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    // Deliberately vague to the caller, specific in the log. Telling an
    // unauthenticated caller WHY their signature failed helps only them.
    log.warn('webhook signature rejected', { controller, tenantId });
    return { ok: false, status: 401, reason: 'signature mismatch' };
  }

  if (scheme.timestampHeader) {
    const raw = req.headers[scheme.timestampHeader];
    const sent = Number(raw) * (raw && raw.length <= 10 ? 1000 : 1);
    if (!raw || Number.isNaN(sent)) {
      return { ok: false, status: 400, reason: 'missing or unparseable timestamp' };
    }
    if (Math.abs(now() - sent) > REPLAY_WINDOW_MS) {
      log.warn('webhook outside replay window', { controller, tenantId, skewMs: now() - sent });
      return { ok: false, status: 408, reason: 'timestamp outside replay window' };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return { ok: false, status: 400, reason: 'body is not JSON' };
  }

  // Vendors differ on whether a delivery is one alert or a batch of them.
  // Normalising to an array here means the connector never has to care.
  const records = Array.isArray(parsed) ? parsed : [parsed];

  return {
    ok: true,
    batch: {
      tenantId,
      encoding: 'webhook',
      receivedAt: new Date(now()).toISOString(),
      source: { collector: controller + '-webhook', resource: 'alerts' },
      records,
    },
  };
}

function decodeSignature(presented: string, encoding: 'hex' | 'base64url'): Uint8Array | undefined {
  try {
    if (encoding === 'base64url') return b64urlDecode(presented);
    if (presented.length % 2 !== 0) return undefined;
    const out = new Uint8Array(presented.length / 2);
    for (let i = 0; i < out.length; i++) {
      const byte = Number.parseInt(presented.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) return undefined;
      out[i] = byte;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Sign a body the way a vendor would. Used by the tests and the demo. */
export function signWebhook(
  controller: string, body: string, secret: string, timestampMs: number,
): Record<string, string> {
  const scheme = SCHEMES[controller];
  if (!scheme) throw new Error('unknown controller ' + controller);

  const headers: Record<string, string> = {};
  if (scheme.timestampHeader) headers[scheme.timestampHeader] = String(timestampMs);
  headers[scheme.signatureHeader] = toHex(
    hmacSha256(secret, scheme.signedPayload({ body, headers })),
  );
  return headers;
}
