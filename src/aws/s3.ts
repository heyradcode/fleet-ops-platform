/**
 * S3 - the raw landing zone.
 *
 * Design rule: ALWAYS persist the untouched vendor payload before you
 * normalise it. Normalisation is code, code has bugs, and when you fix the bug
 * you want to replay history rather than beg the vendor for last month's data.
 * This is the "bronze" layer of a medallion architecture.
 *
 * Key layout is hive-partitioned so Athena/Glue can prune by date:
 *   raw/tenant=acme/provider=samsara/dt=2026-09-08/hh=14/<uuid>.json
 *
 * Bucket policy essentials: block public access, SSE-KMS, versioning on, and a
 * lifecycle rule moving objects to Glacier Instant Retrieval after 90 days.
 */
import { uuid } from '../platform/crypto.ts';
import { log } from '../platform/logger.ts';
import type { RawRecord, Telemetry } from '../platform/types.ts';
import { env } from '../platform/env.ts';

export class S3Bucket {
  readonly name: string;
  #objects = new Map<string, string>();

  constructor(name: string) { this.name = name; }

  putObject(key: string, body: unknown): string {
    this.#objects.set(key, JSON.stringify(body));
    return 's3://' + this.name + '/' + key;
  }

  getObject(key: string): unknown {
    const raw = this.#objects.get(key);
    return raw ? JSON.parse(raw) : undefined;
  }

  listKeys(prefix = ''): string[] {
    return [...this.#objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** Bytes stored - the demo prints this to show the raw layer is real. */
  totalBytes(): number {
    return [...this.#objects.values()].reduce((n, v) => n + v.length, 0);
  }
}

export const rawBucket = new S3Bucket(env('RAW_BUCKET', 'meridian-dev-raw'));

export function archiveRaw(record: RawRecord): string {
  const d = new Date(record.fetchedAt);
  const dt = d.toISOString().slice(0, 10);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const key = [
    'raw',
    'tenant=' + record.tenantId,
    'provider=' + record.provider,
    'dt=' + dt,
    'hh=' + hh,
    uuid() + '.json',
  ].join('/');

  const uri = rawBucket.putObject(key, record);
  log.debug('archived raw payload', { uri });
  return uri;
}

// ---------------------------------------------------------------------------
// The cold path: position history
// ---------------------------------------------------------------------------

/**
 * The other half of the hot/cold split, and the reason the operational store
 * stays affordable.
 *
 *   hot   DynamoDB   one item per driver, OVERWRITTEN    330k items, always
 *   cold  S3         append-only                          ~950M rows/day
 *
 * They answer different questions and have opposite access patterns. "Where is
 * everyone right now" is a key-value lookup; "what happened on this route last
 * Tuesday" is an analytics scan. Putting history in the operational store makes
 * the operational store slow and expensive, and putting current position in S3
 * makes the dispatch board impossible.
 *
 * In production this is Kinesis Data Firehose, not a direct PutObject: it
 * buffers (say 128MB or 60s), converts to Parquet via a Glue schema, and writes
 * hive-partitioned keys that Athena can prune. Buffering is what turns hundreds
 * of millions of tiny records into a manageable number of large columnar files -
 * one object per record would cost more in PUT requests than in storage, and
 * Athena would spend its time opening files rather than reading them.
 */
export const historyBucket = new S3Bucket(env('HISTORY_BUCKET', 'meridian-dev-history'));

export function appendHistory(readings: Telemetry[]): string | undefined {
  if (readings.length === 0) return undefined;

  // Firehose batches by time and size; one call here stands in for one
  // delivered object.
  const first = readings[0];
  const d = new Date(first.observedAt);
  const key = [
    'telemetry',
    'tenant=' + first.tenantId,
    'dt=' + d.toISOString().slice(0, 10),
    'hh=' + String(d.getUTCHours()).padStart(2, '0'),
    uuid() + '.parquet.json',      // .json here; real Firehose writes Parquet
  ].join('/');

  const uri = historyBucket.putObject(key, readings);
  log.debug('appended position history', { uri, records: readings.length });
  return uri;
}
