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
import type { FlowObservation, Observation } from '../platform/types.ts';
import type { RawBatch } from '../integrations/wire.ts';
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

export const rawBucket = new S3Bucket(env('RAW_BUCKET', 'netpulse-dev-raw'));

/**
 * Archive one raw batch, whichever half of the pipeline produced it.
 *
 * `vendorHint` is exactly that - a hint. For a polled controller it is the
 * controller's own name and reliable; for a pushed batch it is whatever the
 * collector guessed from the source address, and in a mixed estate it is
 * routinely wrong. No decoder or mapper is ever selected from it. It earns its
 * place in the key only because it turns "replay one vendor's traffic after a
 * mapper fix" into a prefix scan instead of a full-bucket scan.
 */
export function archiveRaw(batch: RawBatch, vendorHint: string): string {
  const d = new Date(batch.receivedAt);
  const dt = d.toISOString().slice(0, 10);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const key = [
    'raw',
    'tenant=' + batch.tenantId,
    'vendor=' + vendorHint,
    'encoding=' + batch.encoding,
    'dt=' + dt,
    'hh=' + hh,
    uuid() + '.json',
  ].join('/');

  const uri = rawBucket.putObject(key, batch);
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
 *   hot   DynamoDB   one item per device, OVERWRITTEN    330k items, always
 *   cold  S3         append-only                          ~950M rows/day
 *
 * They answer different questions and have opposite access patterns. "Where is
 * everyone right now" is a key-value lookup; "what happened on this route last
 * Tuesday" is an analytics scan. Putting history in the operational store makes
 * the operational store slow and expensive, and putting current position in S3
 * makes the operations board impossible.
 *
 * In production this is Kinesis Data Firehose, not a direct PutObject: it
 * buffers (say 128MB or 60s), converts to Parquet via a Glue schema, and writes
 * hive-partitioned keys that Athena can prune. Buffering is what turns hundreds
 * of millions of tiny records into a manageable number of large columnar files -
 * one object per record would cost more in PUT requests than in storage, and
 * Athena would spend its time opening files rather than reading them.
 */
export const historyBucket = new S3Bucket(env('HISTORY_BUCKET', 'netpulse-dev-history'));

export function appendHistory(observations: Observation[]): string | undefined {
  if (observations.length === 0) return undefined;

  // Firehose batches by time and size; one call here stands in for one
  // delivered object.
  const first = observations[0];
  const d = new Date(first.observedAt);
  const key = [
    'observations',
    'tenant=' + first.tenantId,
    'dt=' + d.toISOString().slice(0, 10),
    'hh=' + String(d.getUTCHours()).padStart(2, '0'),
    uuid() + '.parquet.json',      // .json here; real Firehose writes Parquet
  ].join('/');

  const uri = historyBucket.putObject(key, observations);
  log.debug('appended observation history', { uri, records: observations.length });
  return uri;
}

/**
 * Flows, kept apart from everything else.
 *
 * A separate bucket and a separate prefix, because flow records are a different
 * problem in every dimension that matters: there are two or three orders of
 * magnitude more of them, they are never read back operationally, and their
 * useful life is a fortnight rather than a year. Mixing them into the
 * observation history would drag one lifecycle policy and one partitioning
 * scheme across two workloads that want opposite ones.
 *
 * PARTITIONED BY EXPORTER as well as by hour. Flow analysis is nearly always
 * "what went through this device", and a partition that Athena can prune on is
 * the difference between scanning one exporter's day and scanning the estate's.
 */
export const flowBucket = new S3Bucket(env('FLOW_BUCKET', 'netpulse-dev-flows'));

export function appendFlows(flows: FlowObservation[]): string | undefined {
  if (flows.length === 0) return undefined;

  const first = flows[0];
  const d = new Date(first.flowEnd);
  const key = [
    'flows',
    'tenant=' + first.tenantId,
    'exporter=' + first.deviceId,
    'dt=' + d.toISOString().slice(0, 10),
    'hh=' + String(d.getUTCHours()).padStart(2, '0'),
    uuid() + '.parquet.json',
  ].join('/');

  const uri = flowBucket.putObject(key, flows);
  log.debug('appended flow records', { uri, records: flows.length });
  return uri;
}
