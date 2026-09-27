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
 * they report. Observation *history* is appended to S3 instead - a large estate
 * produces hundreds of millions of records a day, and holding them in
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
 * FLOWS ARE NOT HERE AT ALL. Aggregated traffic records go to S3 as columnar
 * files and are queried with Athena. They are the one observation class whose
 * volume would make this table scale with traffic rather than with incidents.
 *
 * The rule worth internalising: *model your access patterns first, then
 * derive the keys*. Never the other way round.
 *
 * EVERY METHOD IS ASYNC, including on the in-memory table, which could answer
 * synchronously. That is the point: a real table is a network call, and code
 * written against a synchronous fake cannot be pointed at it without being
 * rewritten. The failure worth fearing is a write without `await` - in memory
 * it lands anyway, so every test passes, and against DynamoDB it is a lost
 * write or a read that races it. `scripts/check-floating-promises.mjs` fails
 * `pnpm verify` on one.
 *
 * `mainTable` forwards to whichever store is set. The real adapter is
 * registered by a Lambda entry point (`setTableStore`), never by anything the
 * browser loads - the same shape as `platform/membership.ts`, and for the same
 * reason: one `@aws-sdk` import in the shared graph breaks the board's build,
 * and the portability grep does not catch it.
 */
import type { Principal } from '../platform/types.ts';
import { log } from '../platform/logger.ts';
import { env } from '../platform/env.ts';

export type Item = Record<string, unknown> & { PK: string; SK: string; GSI1PK?: string; GSI1SK?: string };

export interface QueryOptions {
  pk: string;
  skBeginsWith?: string;
  skBetween?: [string, string];
  scanIndexForward?: boolean;
  limit?: number;
  index?: 'GSI1';
}

/**
 * The five operations the platform uses, and no more. Anything a real adapter
 * cannot do in one DynamoDB call does not belong here - a Scan especially.
 */
export interface TableStore {
  readonly name: string;
  put(item: Item): Promise<void>;
  batchPut(items: Item[]): Promise<void>;
  get(pk: string, sk: string): Promise<Item | undefined>;
  delete(pk: string, sk: string): Promise<void>;
  query(opts: QueryOptions): Promise<Item[]>;
}

/** Stand-in for one physical DynamoDB table. */
export class DynamoTable implements TableStore {
  readonly name: string;
  /** PK -> (SK -> item). A real table is a hash of sorted ranges; so is this. */
  #items = new Map<string, Map<string, Item>>();
  /** Cheap consumed-capacity counter so the demo can show query efficiency. */
  stats = { puts: 0, queries: 0, itemsScanned: 0 };

  constructor(name: string) { this.name = name; }

  /** PutItem. Idempotent by construction because our SKs embed a content hash. */
  async put(item: Item): Promise<void> {
    this.#put(item);
  }

  #put(item: Item): void {
    const part = this.#items.get(item.PK) ?? new Map<string, Item>();
    part.set(item.SK, item);
    this.#items.set(item.PK, part);
    this.stats.puts++;
  }

  /** BatchWriteItem - real limit is 25 items per call, so we chunk. */
  async batchPut(items: Item[]): Promise<void> {
    for (let i = 0; i < items.length; i += 25) {
      for (const it of items.slice(i, i + 25)) this.#put(it);
    }
    log.debug('batchWrite', { table: this.name, items: items.length, requests: Math.ceil(items.length / 25) });
  }

  async get(pk: string, sk: string): Promise<Item | undefined> {
    return this.#items.get(pk)?.get(sk);
  }

  /** DeleteItem. Deleting an item that is not there is not an error, as in DynamoDB. */
  async delete(pk: string, sk: string): Promise<void> {
    this.#items.get(pk)?.delete(sk);
  }

  /**
   * Query one partition, optionally restricted to a sort-key prefix/range and
   * reversed. This is the ONLY read pattern you should be using in production.
   */
  async query(opts: QueryOptions): Promise<Item[]> {
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

  /**
   * Only here to prove a point in the demo: how bad a Scan is. Synchronous,
   * and deliberately NOT on TableStore - no production path may call it.
   */
  scanEverything(): Item[] {
    const all = [...this.#items.values()].flatMap((p) => [...p.values()]);
    this.stats.itemsScanned += all.length;
    log.warn('Scan executed - reads the whole table, cost grows with data not results', { items: all.length });
    return all;
  }

  size(): number { return [...this.#items.values()].reduce((n, p) => n + p.size, 0); }
}

/**
 * The in-memory table. Tests and the demo reach for it directly when they want
 * what only a fake can give - its size, its counters, a Scan.
 */
export const memoryTable = new DynamoTable(env('TABLE_NAME', 'netpulse-dev-main'));

let store: TableStore = memoryTable;

/** Point the platform at a real table. Called by Lambda entry points only. */
export function setTableStore(next: TableStore): void { store = next; }

/** Back to the in-memory table. For tests. */
export function resetTableStore(): void { store = memoryTable; }

/**
 * What every repository function calls. It forwards on each call rather than
 * capturing the store at import time, so `setTableStore` works whenever it runs.
 */
export const mainTable: TableStore = {
  get name() { return store.name; },
  put: (item) => store.put(item),
  batchPut: (items) => store.batchPut(items),
  get: (pk, sk) => store.get(pk, sk),
  delete: (pk, sk) => store.delete(pk, sk),
  query: (opts) => store.query(opts),
};

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
