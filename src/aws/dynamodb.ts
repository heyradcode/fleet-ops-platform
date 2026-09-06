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
 *   TENANT#acme#DRIVER                DRIVER#drv-0142           Driver
 *   TENANT#acme#TELEMETRY             2026-09-08T14:30Z#tlm_ab  Telemetry
 *   TENANT#acme#EXCEPTION             2026-09-08T14:31Z#exc_3c  Exception
 *   TENANT#acme#INCIDENT              2026-09-08T14:32Z#inc_7f  Incident
 *
 * THE DRIVER ITEM IS OVERWRITTEN, NEVER APPENDED. One item per driver holds
 * current position and status; at 330k drivers that is 330k items no matter how
 * often devices report. Position *history* is appended to S3 instead, because
 * ~950M rows a day in the operational store would be both slow and ruinous.
 * That split is the single most consequential storage decision in the platform.
 *
 * Because the SK starts with a timestamp, "give me this tenant's telemetry from
 * the last hour, newest first" is one Query with a `begins_with` / range
 * condition and `ScanIndexForward: false`. No scan, no filter, O(result size).
 *
 * GSI1 flips it so we can ask "all readings for driver drv-0142 across vendors":
 *   GSI1PK = TENANT#acme#DRIVER#drv-0142 , GSI1SK = observedAt
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

export const mainTable = new DynamoTable(env('TABLE_NAME', 'meridian-dev-main'));

/** Key builders live next to the table so the layout is documented in one place. */
export const keys = {
  /** The hot-state item. One per driver, overwritten on every position ping. */
  driver: (p: Principal, driverId: string) => ({
    PK: `TENANT#${p.tenantId}#DRIVER`, SK: `DRIVER#${driverId}`,
  }),
  /**
   * GSI1 on the driver item flips driver -> district, which is what makes a
   * dispatcher's board one Query instead of a scan-and-filter over the fleet.
   */
  driverByDistrict: (p: Principal, districtId: string, driverId: string) => ({
    GSI1PK: `TENANT#${p.tenantId}#DISTRICT#${districtId}`, GSI1SK: `DRIVER#${driverId}`,
  }),
  telemetry: (p: Principal, observedAt: string, id: string) => ({
    PK: `TENANT#${p.tenantId}#TELEMETRY`, SK: `${observedAt}#${id}`,
  }),
  telemetryByDriver: (p: Principal, driverId: string, observedAt: string) => ({
    GSI1PK: `TENANT#${p.tenantId}#DRIVER#${driverId}`, GSI1SK: observedAt,
  }),
  exception: (p: Principal, raisedAt: string, id: string) => ({
    PK: `TENANT#${p.tenantId}#EXCEPTION`, SK: `${raisedAt}#${id}`,
  }),
  incident: (p: Principal, openedAt: string, id: string) => ({
    PK: `TENANT#${p.tenantId}#INCIDENT`, SK: `${openedAt}#${id}`,
  }),
};
