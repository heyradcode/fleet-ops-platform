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
 *   TENANT#acme#SITE                  SITE#dal-01               Site
 *   TENANT#acme#SIGNAL                2026-09-04T10:00Z#sig_ab  Signal
 *   TENANT#acme#INCIDENT              2026-09-04T10:02Z#inc_7f  Incident
 *
 * Because the SK starts with a timestamp, "give me this tenant's signals from
 * the last hour, newest first" is one Query with a `begins_with` / range
 * condition and `ScanIndexForward: false`. No scan, no filter, O(result size).
 *
 * GSI1 flips it so we can ask "all signals for site dal-01 across providers":
 *   GSI1PK = TENANT#acme#SITE#dal-01 , GSI1SK = observedAt
 *
 * The rule to repeat in an interview: *model your access patterns first, then
 * derive the keys*. Never the other way round.
 */
import type { Principal } from '../platform/types.ts';
import { log } from '../platform/logger.ts';

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

export const mainTable = new DynamoTable(process.env.TABLE_NAME ?? 'meridian-dev-main');

/** Key builders live next to the table so the layout is documented in one place. */
export const keys = {
  site: (p: Principal, siteId: string) => ({ PK: `TENANT#${p.tenantId}#SITE`, SK: `SITE#${siteId}` }),
  signal: (p: Principal, observedAt: string, id: string) => ({
    PK: `TENANT#${p.tenantId}#SIGNAL`, SK: `${observedAt}#${id}`,
  }),
  signalBySite: (p: Principal, siteId: string, observedAt: string) => ({
    GSI1PK: `TENANT#${p.tenantId}#SITE#${siteId}`, GSI1SK: observedAt,
  }),
  incident: (p: Principal, openedAt: string, id: string) => ({
    PK: `TENANT#${p.tenantId}#INCIDENT`, SK: `${openedAt}#${id}`,
  }),
};
