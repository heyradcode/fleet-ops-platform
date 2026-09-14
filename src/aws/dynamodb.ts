/**
 * ---------------------------------------------------------------------------
 * DynamoDB - single-table design, faked in memory
 * ---------------------------------------------------------------------------
 * The method names and the PK/SK shape below are exactly what you would write
 * against @aws-sdk/lib-dynamodb. Only the storage is fake.
 *
 * SINGLE-TABLE DESIGN in one paragraph: DynamoDB has no joins, so instead of
 * one table per entity you put every entity in one table and design the
 * partition key (PK) / sort key (SK) so that the items you want to fetch
 * *together* sort *next to each other*. You then "query" a prefix.
 *
 *   PK                                SK                        entity
 *   TENANT#acme#DEVICE                DEVICE#dev-core-dal01     DeviceState
 *   TENANT#acme#OBSERVATION           2026-09-08T14:30Z#obs_ab  Observation
 *   TENANT#acme#ALARM                 2026-09-08T14:31Z#alm_3c  Alarm
 *   TENANT#acme#INCIDENT              2026-09-08T14:32Z#inc_7f  Incident
 *
 * THE DEVICE ITEM IS OVERWRITTEN, NEVER APPENDED. One item per device holds
 * current status and load; at 40k devices that is 40k items no matter how often
 * they report. Observation *history* is appended to S3 instead - a syslog-heavy
 * estate produces hundreds of millions of records a day, and holding them in
 * the operational store would be both slow and ruinous. That split is the
 * single most consequential storage decision in the platform.
 *
 * Because the SK starts with a timestamp, "give me this tenant's observations
 * from the last hour, newest first" is one Query with a `begins_with` / range
 * condition and `ScanIndexForward: false`. No scan, no filter, O(result size).
 *
 * GSI1 flips it so we can ask "everything seen about dev-core-dal01, across
 * every feed and both planes":
 *   GSI1PK = TENANT#acme#DEVICE#dev-core-dal01 , GSI1SK = observedAt
 *
 * FLOWS ARE NOT HERE AT ALL. IPFIX records go straight to S3 as columnar files
 * and are queried with Athena. They are the one observation class whose volume
 * would make this table's cost scale with traffic rather than with incidents.
 *
 * The rule worth internalising: *model your access patterns first, then
 * derive the keys*. Never the other way round.
 */
import type { Principal } from '../platform/types.ts';
import { log } from '../platform/logger.ts';
import { env } from '../platform/env.ts';

export type Item = Record<string, unknown> & { PK: string; SK: string; GSI1PK?: string; GSI1SK?: string };

/** Stand-in for one physical DynamoDB table. */
export class DynamoTable {
  readonly name: string;
  /** PK -> (SK -> item). A real table is a hash of sorted ranges; so is this. */
  #items = new Map<string, Map<string, Item>>();
  /** Cheap consumed-capacity counter so the demo can show query efficiency. */
  stats = { puts: 0, queries: 0, itemsScanned: 0 };

  constructor(name: string) { this.name = name; }

  /** PutItem. Idempotent by construction because our SKs embed a content hash. */
  put(item: Item): void {
    const part = this.#items.get(item.PK) ?? new Map<string, Item>();
    part.set(item.SK, item);
    this.#items.set(item.PK, part);
    this.stats.puts++;
  }

  /** BatchWriteItem - real limit is 25 items per call, so we chunk. */
  batchPut(items: Item[]): void {
    for (let i = 0; i < items.length; i += 25) {
      for (const it of items.slice(i, i + 25)) this.put(it);
    }
    log.debug('batchWrite', { table: this.name, items: items.length, requests: Math.ceil(items.length / 25) });
  }

  get(pk: string, sk: string): Item | undefined {
    return this.#items.get(pk)?.get(sk);
  }

  /**
   * Query one partition, optionally restricted to a sort-key prefix/range and
   * reversed. This is the ONLY read pattern you should be using in production.
   */
  query(opts: {
    pk: string;
    skBeginsWith?: string;
    skBetween?: [string, string];
    scanIndexForward?: boolean;
    limit?: number;
    index?: 'GSI1';
  }): Item[] {
    this.stats.queries++;
    let rows: Item[];

    if (opts.index === 'GSI1') {
      // A GSI is a separate, eventually-consistent projection of the table.
      // We rebuild it on the fly here; DynamoDB maintains it for you.
      rows = [...this.#items.values()]
        .flatMap((p) => [...p.values()])
        .filter((i) => i.GSI1PK === opts.pk)
        .sort((a, b) => String(a.GSI1SK).localeCompare(String(b.GSI1SK)));
    } else {
      rows = [...(this.#items.get(opts.pk)?.values() ?? [])]
        .sort((a, b) => a.SK.localeCompare(b.SK));
    }

    const key = (i: Item) => (opts.index === 'GSI1' ? String(i.GSI1SK) : i.SK);
    if (opts.skBeginsWith) rows = rows.filter((i) => key(i).startsWith(opts.skBeginsWith!));
    if (opts.skBetween) rows = rows.filter((i) => key(i) >= opts.skBetween![0] && key(i) <= opts.skBetween![1]);
    if (opts.scanIndexForward === false) rows.reverse();

    this.stats.itemsScanned += rows.length;
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  /** Only here to prove a point in the demo: how bad a Scan is. */
  scanEverything(): Item[] {
    const all = [...this.#items.values()].flatMap((p) => [...p.values()]);
    this.stats.itemsScanned += all.length;
    log.warn('Scan executed - reads the whole table, cost grows with data not results', { items: all.length });
    return all;
  }

  size(): number { return [...this.#items.values()].reduce((n, p) => n + p.size, 0); }
}

export const mainTable = new DynamoTable(env('TABLE_NAME', 'netpulse-dev-main'));

/** Key builders live next to the table so the layout is documented in one place. */
export const keys = {
  /** The hot-state item. One per device, overwritten on every observation. */
  device: (p: Principal, deviceId: string) => ({
    PK: `TENANT#${p.tenantId}#DEVICE`, SK: `DEVICE#${deviceId}`,
  }),
  /**
   * GSI1 on the device item flips device -> site, which is what makes a site
   * operator's board one Query instead of a scan-and-filter over the estate.
   */
  deviceBySite: (p: Principal, siteId: string, deviceId: string) => ({
    GSI1PK: `TENANT#${p.tenantId}#SITE#${siteId}`, GSI1SK: `DEVICE#${deviceId}`,
  }),
  observation: (p: Principal, observedAt: string, id: string) => ({
    PK: `TENANT#${p.tenantId}#OBSERVATION`, SK: `${observedAt}#${id}`,
  }),
  observationByDevice: (p: Principal, deviceId: string, observedAt: string) => ({
    GSI1PK: `TENANT#${p.tenantId}#DEVICE#${deviceId}`, GSI1SK: observedAt,
  }),
  alarm: (p: Principal, raisedAt: string, id: string) => ({
    PK: `TENANT#${p.tenantId}#ALARM`, SK: `${raisedAt}#${id}`,
  }),
  incident: (p: Principal, openedAt: string, id: string) => ({
    PK: `TENANT#${p.tenantId}#INCIDENT`, SK: `${openedAt}#${id}`,
  }),
};
