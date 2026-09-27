/**
 * ---------------------------------------------------------------------------
 * DynamoDB - the real table, behind the same TableStore as the in-memory one
 * ---------------------------------------------------------------------------
 * NODE ONLY. Nothing the browser loads may import this file: it pulls in
 * `@aws-sdk/client-dynamodb`, and a bundler resolves imports whether or not
 * the code path runs. Registered with `setTableStore` by an entry point that
 * only Node reads - the same split as `platform/membership.dynamodb.ts`.
 *
 * What the in-memory table never had to do, and this one must:
 *
 *   PAGINATE. A Query returns at most 1 MB. Stop after the first page and
 *   nothing errors - you get a SHORTER answer, a directory missing users, a
 *   board that looks calm. Same failure as the vendor clouds' paging, same
 *   fix: loop on LastEvaluatedKey until it is gone or the limit is reached.
 *
 *   RETRY UNPROCESSED BATCH ITEMS. BatchWriteItem returns 200 with the items
 *   it did not write in `UnprocessedItems` when throttled. Ignore that field
 *   and writes vanish under load with a success code.
 *
 *   REFUSE DUPLICATE KEYS IN ONE BATCH. DynamoDB rejects a batch naming the
 *   same PK/SK twice; the in-memory table quietly let the last one win. The
 *   adapter keeps that meaning - last write wins - by deduplicating first.
 *
 *   READ STRONGLY on the base table. A poll writes, then the board reads what
 *   it wrote in the same request; an eventually-consistent read can miss it.
 *   Double the read cost, which at this scale is nothing. A GSI cannot be read
 *   consistently at all, which is fine for the device-by-site view.
 *
 * Marshalling is done here rather than with `@aws-sdk/lib-dynamodb`: the
 * items are plain JSON-shaped records, the rules fit on one screen, and it is
 * one dependency fewer. `undefined` is omitted - the document client's
 * `removeUndefinedValues` - because DynamoDB has no such value.
 */
import {
  BatchWriteItemCommand, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand,
  type AttributeValue, type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import type { Item, QueryOptions, TableStore } from './dynamodb.ts';

// ---------------------------------------------------------------------------
// Marshalling
// ---------------------------------------------------------------------------

/** A JS value as a DynamoDB attribute. `undefined` means "omit the attribute". */
export function toAttribute(value: unknown): AttributeValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'boolean') return { BOOL: value };
  if (typeof value === 'number') {
    // NaN and Infinity have no DynamoDB representation. Refuse rather than
    // store a string that reads back as a different type.
    if (!Number.isFinite(value)) throw new TypeError('cannot store a non-finite number: ' + value);
    return { N: String(value) };
  }
  if (Array.isArray(value)) {
    // An undefined array element becomes NULL, as JSON.stringify makes it
    // null: dropping it would shift every later index.
    return { L: value.map((v) => toAttribute(v) ?? { NULL: true }) };
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return { M: toItem(value as Record<string, unknown>) };
  }
  throw new TypeError('cannot store a ' + (value as object)?.constructor?.name + ' - store plain data');
}

export function toItem(record: Record<string, unknown>): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(record)) {
    const a = toAttribute(v);
    if (a !== undefined) out[k] = a;
  }
  return out;
}

export function fromAttribute(a: AttributeValue): unknown {
  if (a.S !== undefined) return a.S;
  if (a.N !== undefined) return Number(a.N);
  if (a.BOOL !== undefined) return a.BOOL;
  if (a.NULL) return null;
  if (a.L) return a.L.map(fromAttribute);
  if (a.M) return fromItem(a.M);
  // Sets are never written by this adapter, but the membership rows are
  // written by Terraform with SS - read them as arrays rather than lose them.
  if (a.SS) return [...a.SS];
  if (a.NS) return a.NS.map(Number);
  throw new TypeError('unsupported attribute type: ' + Object.keys(a).join(','));
}

export function fromItem(item: Record<string, AttributeValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) out[k] = fromAttribute(v);
  return out;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** What the adapter needs from the SDK: `client.send`. Injected, so tests need no AWS. */
export type Send = (command: object) => Promise<Record<string, unknown>>;

export type SdkTableOptions = {
  /** Defaults to a real client's `send`. */
  send?: Send;
  /** Backoff between unprocessed-item retries. Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Attempts at a batch before giving up loudly. */
  maxBatchAttempts?: number;
};

export function createSdkTableStore(tableName: string, opts: SdkTableOptions = {}): TableStore {
  let send = opts.send;
  if (!send) {
    // At creation, not per call: a Lambda container is reused, and the client
    // keeps its connection pool and credential cache across invocations.
    const client = new DynamoDBClient({});
    send = async (command) => (await client.send(command as never)) as unknown as Record<string, unknown>;
  }
  const call = send;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxBatchAttempts = opts.maxBatchAttempts ?? 8;
  const key = (pk: string, sk: string) => ({ PK: { S: pk }, SK: { S: sk } });

  return {
    name: tableName,

    async put(item: Item) {
      await call(new PutItemCommand({ TableName: tableName, Item: toItem(item) }));
    },

    async batchPut(items: Item[]) {
      // Last write wins within the call, as in memory - and DynamoDB refuses a
      // batch that names one key twice.
      const unique = [...new Map(items.map((i) => [i.PK + '\u0000' + i.SK, i])).values()];
      for (let i = 0; i < unique.length; i += 25) {
        let pending: WriteRequest[] = unique.slice(i, i + 25).map((it) => ({ PutRequest: { Item: toItem(it) } }));
        for (let attempt = 1; pending.length > 0; attempt++) {
          if (attempt > maxBatchAttempts) {
            // Loud. Returning would report success for writes that never landed.
            throw new Error('BatchWriteItem: ' + pending.length + ' item(s) still unprocessed after ' +
              maxBatchAttempts + ' attempts on ' + tableName);
          }
          const out = await call(new BatchWriteItemCommand({ RequestItems: { [tableName]: pending } }));
          pending = ((out.UnprocessedItems as Record<string, WriteRequest[]> | undefined)?.[tableName]) ?? [];
          // Exponential backoff with a cap: unprocessed items mean throttling,
          // and retrying at once only asks to be throttled again.
          if (pending.length > 0) await sleep(Math.min(50 * 2 ** (attempt - 1), 2000));
        }
      }
    },

    async get(pk: string, sk: string) {
      const out = await call(new GetItemCommand({ TableName: tableName, Key: key(pk, sk), ConsistentRead: true }));
      const item = out.Item as Record<string, AttributeValue> | undefined;
      return item ? fromItem(item) as Item : undefined;
    },

    async delete(pk: string, sk: string) {
      await call(new DeleteItemCommand({ TableName: tableName, Key: key(pk, sk) }));
    },

    async query(o: QueryOptions) {
      if (o.skBeginsWith !== undefined && o.skBetween) {
        // One sort-key condition per Query is all DynamoDB allows. The
        // in-memory table would have applied both; better to fail here than
        // return a different answer in production.
        throw new Error('query: skBeginsWith and skBetween cannot be combined');
      }
      const gsi = o.index === 'GSI1';
      const names: Record<string, string> = { '#pk': gsi ? 'GSI1PK' : 'PK', '#sk': gsi ? 'GSI1SK' : 'SK' };
      const values: Record<string, AttributeValue> = { ':pk': { S: o.pk } };
      let condition = '#pk = :pk';
      if (o.skBeginsWith !== undefined) {
        condition += ' AND begins_with(#sk, :sk)';
        values[':sk'] = { S: o.skBeginsWith };
      } else if (o.skBetween) {
        condition += ' AND #sk BETWEEN :lo AND :hi';
        values[':lo'] = { S: o.skBetween[0] };
        values[':hi'] = { S: o.skBetween[1] };
      } else {
        delete names['#sk'];   // an unused name is a ValidationException
      }

      const rows: Item[] = [];
      let startKey: Record<string, AttributeValue> | undefined;
      do {
        const out = await call(new QueryCommand({
          TableName: tableName,
          IndexName: gsi ? 'GSI1' : undefined,
          KeyConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ScanIndexForward: o.scanIndexForward ?? true,
          // A GSI cannot be read consistently; asking is a ValidationException.
          ConsistentRead: gsi ? undefined : true,
          Limit: o.limit ? o.limit - rows.length : undefined,
          ExclusiveStartKey: startKey,
        }));
        for (const it of (out.Items as Record<string, AttributeValue>[] | undefined) ?? []) rows.push(fromItem(it) as Item);
        startKey = out.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
      } while (startKey && !(o.limit && rows.length >= o.limit));
      return rows;
    },
  };
}
