/**
 * The registry, and the dispatch that runs behind an S3 write.
 *
 * Two lists. Adding an encoding is a decoder plus a line here; adding a vendor
 * is a mapper plus a line here. Nothing else in the platform names either.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN:
 *
 *   1. the S3 key says which ENCODING this object holds  -> pick a decoder
 *   2. the decoder produces structurally parsed records  -> still vendor-native
 *   3. the claimed host resolves against the INVENTORY   -> a real deviceId
 *   4. the inventory says what that device IS            -> vendor + platform
 *   5. that pair selects the candidate mappers           -> one of them claims it
 *
 * Step 4 is the one worth pausing on. The vendor is never sniffed from the
 * record; it is looked up, because we already know what we deployed. A generic
 * SNMP linkDown trap contains nothing vendor-specific at all, and guessing from
 * message text would be inventing an answer we hold with certainty.
 *
 * Step 3 is where records are lost, and losing them quietly would be the worst
 * possible behaviour: an estate where half the syslog fails to resolve looks
 * exactly like a quiet estate. So every drop is counted and the unresolved
 * hostnames are returned, which is what makes "your inventory is stale" a
 * visible number rather than a mystery.
 *
 * NOTHING HERE RETRIES. The raw object is already durable in S3 before this
 * runs - archive first, normalise second, exactly as the fleet pipeline did -
 * so a mapping bug is fixed by deploying the fix and replaying the prefix, not
 * by trying the same broken code again with a backoff.
 */
import type { Encoding, Observation, TenantId } from '../platform/types.ts';
import type { Inventory } from '../platform/inventory.ts';
import type { Decoder, Mapper, RawBatch } from './wire.ts';
import { log } from '../platform/logger.ts';

import { syslogDecoder } from './decode/syslog.ts';
import { snmpTrapDecoder } from './decode/snmp-trap.ts';

import { ciscoIosXeSyslog } from './map/cisco-ios-xe.syslog.ts';
import { ciscoIosXeSnmp } from './map/cisco-ios-xe.snmp.ts';
import { junosSyslog } from './map/junos.syslog.ts';
import { arubaAosCxSyslog } from './map/aruba-aoscx.syslog.ts';

/** One decoder per wire format. Shared by every vendor that speaks it. */
export const decoders: Decoder[] = [
  syslogDecoder,
  snmpTrapDecoder,
];

/**
 * One mapper per (vendor, platform, encoding).
 *
 * Note the shape of this list: three vendors and two encodings produce four
 * files, not six, because a vendor only needs a mapper for the feeds it
 * actually sends us. Organised by vendor instead, the syslog parsing alone
 * would appear in three of them.
 */
export const mappers: Mapper[] = [
  ciscoIosXeSyslog,
  ciscoIosXeSnmp,
  junosSyslog,
  arubaAosCxSyslog,
];

const decoderByEncoding = new Map<Encoding, Decoder>(decoders.map((d) => [d.encoding, d]));

function mapperKey(vendor: string, platform: string, encoding: string): string {
  return vendor + '|' + platform + '|' + encoding;
}

const mappersByTarget = new Map<string, Mapper[]>();
for (const m of mappers) {
  const key = mapperKey(m.vendor, m.platform, m.encoding);
  const list = mappersByTarget.get(key);
  if (list) list.push(m); else mappersByTarget.set(key, [m]);
}

/**
 * What the run did, beyond the observations themselves.
 *
 * Every one of these counters corresponds to a way the pipeline can be quietly
 * broken while appearing to work, which is why they are returned rather than
 * merely logged. `unresolvedHost` climbing means the inventory has drifted;
 * `unclaimed` climbing after a vendor upgrade means message wording changed
 * under a mapper.
 */
export type NormaliseStats = {
  records: number;
  decoded: number;
  observations: number;
  unresolvedHost: number;
  noMapper: number;
  unclaimed: number;
  mapperErrors: number;
};

export type NormaliseResult = {
  observations: Observation[];
  stats: NormaliseStats;
  /** Deduplicated, capped. Enough to chase the problem, not enough to flood a log. */
  unresolvedHosts: string[];
};

const UNRESOLVED_SAMPLE_LIMIT = 20;

/**
 * Normalise one S3 object's worth of raw records.
 *
 * Pure with respect to the outside world: no clock, no network, no randomness.
 * That is what makes replaying the archive produce byte-identical output, and
 * it is the same discipline `normalise()` followed in the fleet build.
 */
export function normaliseBatch(batch: RawBatch, inventory: Inventory): NormaliseResult {
  const stats: NormaliseStats = {
    records: batch.records.length,
    decoded: 0,
    observations: 0,
    unresolvedHost: 0,
    noMapper: 0,
    unclaimed: 0,
    mapperErrors: 0,
  };
  const observations: Observation[] = [];
  const unresolved = new Set<string>();

  const decoder = decoderByEncoding.get(batch.encoding);
  if (!decoder) {
    log.error('no decoder for encoding', { encoding: batch.encoding });
    stats.noMapper = batch.records.length;
    return { observations, stats, unresolvedHosts: [] };
  }

  const decoded = decoder.decode(batch);
  stats.decoded = decoded.length;

  for (const rec of decoded) {
    const deviceId = inventory.resolveDevice(rec.claimedHost);
    if (!deviceId) {
      stats.unresolvedHost++;
      if (unresolved.size < UNRESOLVED_SAMPLE_LIMIT) unresolved.add(rec.claimedHost);
      continue;
    }

    const device = inventory.device(deviceId);
    if (!device) { stats.unresolvedHost++; continue; }

    const candidates = mappersByTarget.get(
      mapperKey(device.vendor, device.platform, batch.encoding),
    );
    if (!candidates || candidates.length === 0) { stats.noMapper++; continue; }

    const ctx = {
      tenantId: batch.tenantId,
      inventory,
      deviceId,
      siteId: inventory.siteOf(deviceId),
      resolveInterface: (opts: { name?: string; ifIndex?: number }) =>
        inventory.resolveInterface(deviceId, opts),
    };

    let claimed = false;
    for (const mapper of candidates) {
      if (!mapper.claims(rec)) continue;
      claimed = true;
      try {
        observations.push(...mapper.map(rec, ctx));
      } catch (err) {
        // A mapping bug in ONE vendor must not lose the others in the batch.
        // The raw object is already in S3, so this is recoverable by replay.
        stats.mapperErrors++;
        log.error('mapper failed', {
          vendor: mapper.vendor, platform: mapper.platform, tag: rec.tag,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!claimed) stats.unclaimed++;
  }

  stats.observations = observations.length;
  return { observations, stats, unresolvedHosts: [...unresolved] };
}

// ---------------------------------------------------------------------------
// The S3 landing zone
// ---------------------------------------------------------------------------

/**
 * Where a collector writes, and how the normaliser knows what it is reading.
 *
 *   raw/tenant=acme/vendor=cisco/encoding=syslog/dt=2026-09-08/hh=14/<uuid>.json
 *
 * Hive-partitioned so Athena and Glue can prune, and - the operational reason -
 * so the S3 event notification can route by prefix and the decoder can be
 * chosen from the KEY without opening the object. Opening a 128MB object to
 * discover which parser it needs is a cost paid on every single invocation.
 *
 * `vendor` is a HINT here and nothing more. It is whatever the collector
 * believed from the source address, it is routinely wrong in a mixed estate,
 * and no mapper is selected from it - that comes from the inventory. It earns
 * its place in the key only because it makes replaying one vendor's traffic
 * after a mapper fix a prefix scan instead of a full-bucket scan.
 */
export function rawKey(args: {
  tenantId: TenantId; vendorHint: string; encoding: Encoding;
  receivedAt: string; objectId: string;
}): string {
  const d = new Date(args.receivedAt);
  return [
    'raw',
    'tenant=' + args.tenantId,
    'vendor=' + args.vendorHint,
    'encoding=' + args.encoding,
    'dt=' + d.toISOString().slice(0, 10),
    'hh=' + String(d.getUTCHours()).padStart(2, '0'),
    args.objectId + '.json',
  ].join('/');
}

/** The inverse: read the partition values back out of a key. */
export function parseRawKey(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of key.split('/')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}
