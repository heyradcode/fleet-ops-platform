/**
 * S3 - the raw landing zone.
 *
 * Design rule: ALWAYS persist the untouched vendor payload before you
 * normalise it. Normalisation is code, code has bugs, and when you fix the bug
 * you want to replay history rather than beg the vendor for last month's data.
 * This is the "bronze" layer of a medallion architecture.
 *
 * Key layout is hive-partitioned so Athena/Glue can prune by date:
 *   raw/tenant=acme/provider=cisco-meraki/dt=2026-09-04/hh=10/<uuid>.json
 *
 * Bucket policy essentials: block public access, SSE-KMS, versioning on, and a
 * lifecycle rule moving objects to Glacier Instant Retrieval after 90 days.
 */
import { randomUUID } from 'node:crypto';
import { log } from '../platform/logger.ts';
import type { RawRecord } from '../platform/types.ts';

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

export const rawBucket = new S3Bucket(process.env.RAW_BUCKET ?? 'netpulse-dev-raw');

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
    randomUUID() + '.json',
  ].join('/');

  const uri = rawBucket.putObject(key, record);
  log.debug('archived raw payload', { uri });
  return uri;
}
