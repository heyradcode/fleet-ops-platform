/**
 * Deterministic-ish id helpers.
 *
 * `telemetryId` is a CONTENT HASH, not a random uuid. That is deliberate: the
 * ingest pipeline is at-least-once (EventBridge and Step Functions both retry,
 * and a driver's device replays its offline buffer), so the same vendor reading
 * can arrive twice. Hashing provider+ref+timestamp makes the DynamoDB PutItem
 * naturally idempotent - the second write simply overwrites the first with
 * identical bytes instead of creating a duplicate.
 *
 * This is one of the most commonly asked serverless design questions:
 *   "your Lambda is retried - how do you avoid double-processing?"
 *
 * The hash comes from `platform/crypto.ts` rather than `node:crypto` because
 * this runs in the browser too, and it has to stay synchronous. See that file.
 */
import { sha256, uuid } from './crypto.ts';

export function telemetryId(provider: string, sourceRef: string, observedAt: string): string {
  return sha256(provider + '|' + sourceRef + '|' + observedAt).slice(0, 24);
}

export function exceptionId(): string { return 'exc_' + uuid().slice(0, 8); }
export function incidentId(): string { return 'inc_' + uuid().slice(0, 8); }
export function traceId(): string { return uuid().slice(0, 8); }
