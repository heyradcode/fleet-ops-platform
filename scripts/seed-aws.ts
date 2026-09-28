/**
 * Fill the REAL DynamoDB table with what the offline board computes.
 *
 *   TABLE_NAME=$(terraform -chdir=infra/terraform/auth output -raw main_table_name) pnpm seed:aws
 *   pnpm seed:aws --dry-run        # the same run through an in-memory table; no AWS at all
 *
 * The same code the board runs in the tab - the comms poll against the vendor
 * mocks, the network estate and its scenario observations - with the store
 * pointed at the table instead. The vendors are still the mocks: real Cognito
 * and real storage do not make the Teams tenant real, and no data here is.
 *
 * LIVES IN scripts/, like mock-vendors.ts: it is a Node entry point, reads
 * `process.env`, and registers the SDK adapter, none of which may happen in
 * anything the browser loads.
 *
 * Credentials are whatever the AWS SDK finds - AWS_PROFILE, SSO, env vars -
 * and need Query, GetItem, PutItem, DeleteItem and BatchWriteItem on the
 * table (infra/terraform/auth/seed-policy.json).
 *
 * RE-RUNNABLE, and RESUMABLE. Another run is another poll, which is what a
 * scheduler would do every five minutes. The eight-week baseline BACKFILL is
 * not re-runnable: the baselines are running statistics, and folding a week
 * in twice narrows the spread and makes ordinary values look anomalous. So
 * each week is recorded in `BACKFILL#PROGRESS` AFTER its writes land - the
 * watermark rule - and a run stopped half-way resumes at the next week
 * instead of starting again or, worse, being mistaken for finished.
 *
 * FAST ENOUGH. At ~300 ms a round trip to us-east-1, the first version made
 * ~1,240 calls one after another: six silent minutes. Writes to different
 * keys now run in parallel (platform/concurrency.ts) and every phase prints.
 */
import { DynamoTable, setTableStore, type Item, type QueryOptions, type TableStore } from '../src/aws/dynamodb.ts';
import { createSdkTableStore } from '../src/aws/dynamodb.sdk.ts';
import { seedDemoData } from './seed-core.ts';

const dryRun = process.argv.includes('--dry-run');
const tableName = process.env.TABLE_NAME ?? '';

if (!dryRun && !tableName) {
  console.error('TABLE_NAME is not set. It is a Terraform output:\n\n' +
    '  TABLE_NAME=$(terraform -chdir=infra/terraform/auth output -raw main_table_name) pnpm seed:aws\n\n' +
    'or `pnpm seed:aws --dry-run` to see what it would write without AWS.');
  process.exit(1);
}

/** Counts every operation, so a dry run can say what the real one would cost. */
function counted(inner: TableStore) {
  const ops = { put: 0, batchPut: 0, batchItems: 0, get: 0, delete: 0, query: 0 };
  const store: TableStore = {
    name: inner.name,
    put: (item: Item) => { ops.put++; return inner.put(item); },
    batchPut: (items: Item[]) => { ops.batchPut += Math.ceil(items.length / 25); ops.batchItems += items.length; return inner.batchPut(items); },
    get: (p: string, s: string) => { ops.get++; return inner.get(p, s); },
    delete: (p: string, s: string) => { ops.delete++; return inner.delete(p, s); },
    query: (o: QueryOptions) => { ops.query++; return inner.query(o); },
  };
  return { store, ops };
}

const { store, ops } = counted(dryRun ? new DynamoTable('dry-run') : createSdkTableStore(tableName));
setTableStore(store);
console.log(dryRun ? 'DRY RUN - in-memory table, no AWS' : 'Writing to DynamoDB table ' + tableName);
const started = performance.now();

// The seeding itself - comms baselines (resumable), the comms poll, the
// network estate - is shared with the local MCP server: scripts/seed-core.ts.
await seedDemoData((line) => console.log(line));

const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log('\n' + (dryRun ? 'Would make' : 'Made') + ': ' +
  ops.put + ' puts, ' + ops.batchPut + ' batch writes (' + ops.batchItems + ' items), ' +
  ops.get + ' gets, ' + ops.delete + ' deletes, ' + ops.query + ' queries' +
  (dryRun ? '' : ' in ' + seconds + ' s'));
