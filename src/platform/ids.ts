/**
 * Id helpers for the things the platform creates itself.
 *
 * The id that matters most - `observationId` - is NOT here. It lives in
 * types.ts next to the model, because it is a content hash rather than a
 * generated value and the tuple it hashes is part of the model's contract. See
 * the note there about at-least-once delivery and idempotent writes.
 *
 * What is left are ids for records the platform authors rather than receives.
 * An alarm and an incident are our own conclusions, created exactly once at the
 * moment we reach them, so a random id is correct and a content hash would be
 * actively wrong - two genuinely separate outages that happen to look alike
 * must not collide.
 *
 * `uuid` comes from `platform/crypto.ts` rather than `node:crypto` because this
 * runs in the browser too, and it has to stay synchronous. See that file.
 */
import { uuid } from './crypto.ts';

export function alarmId(): string { return 'alm_' + uuid().slice(0, 8); }
export function incidentId(): string { return 'inc_' + uuid().slice(0, 8); }
export function traceId(): string { return uuid().slice(0, 8); }
