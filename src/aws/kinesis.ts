/**
 * ---------------------------------------------------------------------------
 * Kinesis Data Streams - the shape of high-volume ingest
 * ---------------------------------------------------------------------------
 * This is the piece that makes the fleet numbers work, so it is worth being
 * precise about what it buys.
 *
 *   330,000 drivers / one ping per 30s  ~=  11,000 records/sec sustained
 *                                            ~950 million/day
 *   peak (shift change, wave dispatch)   ~=  3-5x that
 *
 * At that rate, THREE things stop being optional:
 *
 *   1. You cannot invoke a Lambda per record. An event-source mapping delivers
 *      BATCHES, and the batch size is the difference between ~11,000
 *      invocations/sec and a few dozen.
 *   2. Ordering only matters *per driver*. Partitioning by driverId gives you
 *      ordering where it matters and parallelism everywhere else. Ordering the
 *      whole stream would serialise the entire fleet through one shard.
 *   3. One bad record must not stall a shard. This is the classic Kinesis
 *      outage: a single unparseable record fails the batch, the batch retries
 *      forever, the shard stops advancing, and the backlog grows silently until
 *      somebody notices the iterator-age metric. `BisectBatchOnFunctionError`
 *      plus a failure destination is the fix, and it is implemented below
 *      rather than merely described.
 *
 * WHAT THIS FILE STANDS IN FOR:
 *
 *   await client.send(new PutRecordsCommand({
 *     StreamName, Records: rs.map(r => ({
 *       Data: Buffer.from(JSON.stringify(r)),
 *       PartitionKey: r.driverId,          // ordering per driver
 *     })),
 *   }));
 *
 * and, in Terraform, the event-source mapping that actually does the batching:
 *
 *   resource "aws_lambda_event_source_mapping" "telemetry" {
 *     batch_size                         = 500
 *     maximum_batching_window_in_seconds = 5
 *     parallelization_factor             = 4     # more concurrency per shard
 *     bisect_batch_on_function_error     = true  # <- the one people forget
 *     maximum_retry_attempts             = 3
 *     function_response_types            = ["ReportBatchItemFailures"]
 *     destination_config { on_failure { destination_arn = aws_sqs_queue.dlq.arn } }
 *   }
 */
import { log } from '../platform/logger.ts';
import { sha256 } from '../platform/crypto.ts';
import { env } from '../platform/env.ts';

export type StreamRecord<T> = {
  /** What Kinesis orders and shards on. Here: the driver id. */
  partitionKey: string;
  data: T;
};

/** What a batched consumer is handed, mirroring the Lambda event shape. */
export type Batch<T> = {
  shardId: string;
  records: Array<StreamRecord<T>>;
};

/**
 * The result a batched handler returns.
 *
 * Mirrors `ReportBatchItemFailures`: the handler tells the service which
 * records failed rather than failing the whole batch, so the successful 499 are
 * not reprocessed because of the one that was malformed.
 */
export type BatchResult = { failedIds: string[] };

export type ConsumerOptions = {
  /** Maximum records per invocation. The single biggest cost lever. */
  batchSize: number;
  /**
   * When a batch fails, split it and retry the halves - binary search for the
   * poison record. log2(500) is ~9 extra invocations to isolate one bad record
   * out of five hundred, instead of losing the batch or stalling the shard.
   */
  bisectOnError: boolean;
  /** Attempts per (sub)batch before the records go to the failure destination. */
  maxRetryAttempts: number;
};

const DEFAULTS: ConsumerOptions = {
  batchSize: 500,
  bisectOnError: true,
  maxRetryAttempts: 3,
};

export class KinesisStream<T> {
  readonly name: string;
  readonly shardCount: number;
  /** Records that could not be processed even alone. In AWS: an SQS DLQ. */
  readonly failureDestination: Array<{ record: StreamRecord<T>; error: string }> = [];

  #shards: Map<string, Array<StreamRecord<T>>>;
  #stats = { put: 0, batches: 0, invocations: 0, bisections: 0 };

  constructor(name: string, shardCount = 4) {
    this.name = name;
    this.shardCount = shardCount;
    this.#shards = new Map(
      Array.from({ length: shardCount }, (_, i) => ['shard-' + String(i).padStart(6, '0'), []]),
    );
  }

  /**
   * Which shard a partition key lands on.
   *
   * Kinesis hashes the partition key (MD5) onto the shard's hash-key range.
   * Any stable hash demonstrates the property that matters: the same driver
   * always lands on the same shard, so their records stay ordered.
   */
  shardFor(partitionKey: string): string {
    const h = parseInt(sha256(partitionKey).slice(0, 8), 16);
    return 'shard-' + String(h % this.shardCount).padStart(6, '0');
  }

  putRecords(records: Array<StreamRecord<T>>): void {
    for (const r of records) {
      this.#shards.get(this.shardFor(r.partitionKey))!.push(r);
      this.#stats.put++;
    }
  }

  /**
   * Drain the stream through a batched handler.
   *
   * The handler is invoked once per batch, NOT once per record. That is the
   * whole point, and it is why `processBatch` in the pipeline takes an array.
   */
  async consume(
    handler: (batch: Batch<T>) => Promise<BatchResult> | BatchResult,
    idOf: (record: StreamRecord<T>) => string,
    options: Partial<ConsumerOptions> = {},
  ): Promise<void> {
    const opts = { ...DEFAULTS, ...options };

    for (const [shardId, queue] of this.#shards) {
      while (queue.length > 0) {
        const records = queue.splice(0, opts.batchSize);
        this.#stats.batches++;
        await this.#deliver(shardId, records, handler, idOf, opts, 1);
      }
    }

    log.info('stream drained ' + this.name, {
      records: this.#stats.put,
      batches: this.#stats.batches,
      invocations: this.#stats.invocations,
      bisections: this.#stats.bisections,
      failed: this.failureDestination.length,
    });
  }

  async #deliver(
    shardId: string,
    records: Array<StreamRecord<T>>,
    handler: (batch: Batch<T>) => Promise<BatchResult> | BatchResult,
    idOf: (record: StreamRecord<T>) => string,
    opts: ConsumerOptions,
    attempt: number,
  ): Promise<void> {
    if (records.length === 0) return;

    this.#stats.invocations++;
    let failedIds: string[] = [];

    try {
      const result = await handler({ shardId, records });
      failedIds = result.failedIds;
    } catch (err) {
      // The handler threw rather than reporting failures. Treat the whole
      // batch as failed - which is exactly the situation bisection exists for.
      failedIds = records.map(idOf);
      log.warn('batch handler threw', {
        shardId, records: records.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (failedIds.length === 0) return;

    const failed = records.filter((r) => failedIds.includes(idOf(r)));

    // A single record that still fails has nowhere left to go. Park it and
    // MOVE ON - the alternative is the shard never advancing again.
    if (failed.length === 1) {
      if (attempt >= opts.maxRetryAttempts) {
        this.failureDestination.push({
          record: failed[0],
          error: 'failed after ' + attempt + ' attempts',
        });
        log.error('record sent to failure destination', {
          shardId, partitionKey: failed[0].partitionKey,
        });
        return;
      }
      await this.#deliver(shardId, failed, handler, idOf, opts, attempt + 1);
      return;
    }

    if (!opts.bisectOnError) {
      // Without bisection the whole batch is retried, poison record included,
      // until the attempts run out - and every good record in it is reprocessed
      // every time. This branch exists to make that contrast concrete.
      if (attempt >= opts.maxRetryAttempts) {
        for (const r of failed) {
          this.failureDestination.push({ record: r, error: 'batch failed, no bisection' });
        }
        return;
      }
      await this.#deliver(shardId, failed, handler, idOf, opts, attempt + 1);
      return;
    }

    // Bisect: split and retry each half. Binary search for the poison record.
    this.#stats.bisections++;
    const mid = Math.floor(failed.length / 2);
    await this.#deliver(shardId, failed.slice(0, mid), handler, idOf, opts, attempt);
    await this.#deliver(shardId, failed.slice(mid), handler, idOf, opts, attempt);
  }

  get stats() { return { ...this.#stats }; }

  /** How many records are sitting unread. In AWS: the iterator-age alarm. */
  backlog(): number {
    return [...this.#shards.values()].reduce((n, q) => n + q.length, 0);
  }

  /** Which shards a set of keys would land on - used by the demo. */
  distribution(partitionKeys: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const k of partitionKeys) {
      const shard = this.shardFor(k);
      counts.set(shard, (counts.get(shard) ?? 0) + 1);
    }
    return counts;
  }
}

export const telemetryStream = new KinesisStream<unknown>(
  env('KINESIS_STREAM_NAME', 'meridian-dev-telemetry'),
);
