/**
 * Deterministic-ish id helpers.
 *
 * `signalId` is a CONTENT HASH, not a random uuid. That is deliberate: the
 * ingest pipeline is at-least-once (EventBridge and Step Functions both retry),
 * so the same vendor reading can arrive twice. Hashing provider+ref+timestamp
 * makes the DynamoDB PutItem naturally idempotent - the second write simply
 * overwrites the first with identical bytes instead of creating a duplicate.
 *
 * This is one of the most commonly asked serverless design questions:
 *   "your Lambda is retried - how do you avoid double-processing?"
 */
import { createHash, randomUUID } from 'node:crypto';

export function signalId(provider: string, sourceRef: string, observedAt: string): string {
  return createHash('sha256')
    .update(`${provider}|${sourceRef}|${observedAt}`)
    .digest('hex')
    .slice(0, 24);
}

export function incidentId(): string { return `inc_${randomUUID().slice(0, 8)}`; }
export function traceId(): string { return randomUUID().slice(0, 8); }
