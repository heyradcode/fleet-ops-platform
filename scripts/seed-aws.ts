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
import { DynamoTable, mainTable, setTableStore, type Item, type QueryOptions, type TableStore } from '../src/aws/dynamodb.ts';
import { createSdkTableStore } from '../src/aws/dynamodb.sdk.ts';
import { setClock, fixedClock, now } from '../src/platform/clock.ts';
import { setRandom, seededRandom } from '../src/platform/random.ts';
import { setUuid, seededUuid } from '../src/platform/crypto.ts';
import { pk } from '../src/platform/tenancy.ts';
import { now as clockNow } from '../src/platform/clock.ts';
import type { Principal } from '../src/platform/types.ts';
import { loadEstate, getInventory, allDeviceStates } from '../src/geo/device-repository.ts';
import { buildScenarios } from '../src/data/scenarios.ts';
import { runScenarioFeeds, collapseDuplicates, resolveLocations } from '../src/pipeline/steps.ts';
import { putDeviceStates, putObservations } from '../src/platform/repository.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN,
  directory, mockFetch, mockHistory,
} from '../src/integrations/comms/mock/index.ts';
import { createCommsClient } from '../src/integrations/comms/client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from '../src/integrations/comms/config.ts';
import { backfillCommsBaselines, runCommsPoll } from '../src/integrations/comms/poll.ts';

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

// The same seeding the board and the demo do: fixed clock, seeded ids. The
// mocks' activity is anchored to that clock, so this is also what makes the
// stored incidents the ones the offline board shows.
setClock(fixedClock());
const rng = seededRandom();
setRandom(rng);
setUuid(seededUuid(rng));
loadEstate();

const { store, ops } = counted(dryRun ? new DynamoTable('dry-run') : createSdkTableStore(tableName));
setTableStore(store);
console.log(dryRun ? 'DRY RUN - in-memory table, no AWS' : 'Writing to DynamoDB table ' + tableName);
const started = performance.now();

// --- The comms tenant --------------------------------------------------------
const hhs: Principal = {
  sub: 'seed', email: 'seed@hhs.texas.example', tenantId: HHS_DEMO_TENANT,
  roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
};
const config = COMMS_CONFIG[HHS_DEMO_TENANT];
const client = createCommsClient({
  tenantId: HHS_DEMO_TENANT,
  fetch: mockFetch,
  credentials: {
    entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
    genesys: { ...DEMO_CLIENT },
    webex: { token: DEMO_WEBEX_TOKEN },
    bandwidth: { ...DEMO_BANDWIDTH_USER },
    helix: { ...DEMO_HELIX_USER },
    kurmi: { ...DEMO_KURMI_USER },
    starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
  },
});

const WEEKS = 8;
const elapsed = () => ((performance.now() - started) / 1000).toFixed(1) + 's';
const progressKey = { PK: pk(hhs, 'COMMS'), SK: 'BACKFILL#PROGRESS' };
const record = await mainTable.get(progressKey.PK, progressKey.SK);
const done = new Set<number>((record?.weeksDone as number[] | undefined) ?? []);
const hasBaselines = (await mainTable.query({ pk: pk(hhs, 'BASELINE'), limit: 1 })).length > 0;

if (!record && hasBaselines) {
  // Seeded by a version that kept no record. It may have finished or been
  // stopped half-way; there is no way to tell, and backfilling again would
  // double-count whatever did land. Say so rather than guess.
  console.log('  baselines exist from an earlier seed with no progress record - backfill skipped.\n' +
    '  If that seed was interrupted, delete the TENANT#' + HHS_DEMO_TENANT + '#BASELINE partition and re-run.');
} else if (done.size >= WEEKS) {
  console.log('  baselines complete (' + WEEKS + ' weeks) - backfill skipped');
} else {
  console.log('  backfilling ' + (WEEKS - done.size) + ' of ' + WEEKS + ' weeks' + (done.size ? ' (resuming)' : '') + '...');
  const points = await backfillCommsBaselines(hhs, client, config, now(), WEEKS, mockHistory, {
    done,
    afterWeek: async (weeksAgo, n) => {
      done.add(weeksAgo);
      // AFTER the week's writes - recording it first would let a crash
      // leave a week marked done that never landed.
      await mainTable.put({ ...progressKey, entity: 'BackfillProgress', weeksDone: [...done].sort((a, b) => a - b), at: clockNow() });
      console.log('    week -' + weeksAgo + ': ' + n + ' points  [' + elapsed() + ']');
    },
  });
  console.log('  backfilled ' + points + ' baseline points');
}
console.log('  polling the comms sources...');
const poll = await runCommsPoll(hhs, client, config, now());
console.log('  comms poll [' + elapsed() + ']: ' + poll.incidents.length + ' open incident(s), ' + poll.resolved.length + ' resolved, ' +
  poll.anomalies.length + ' anomal' + (poll.anomalies.length === 1 ? 'y' : 'ies'));

// --- The network tenant ------------------------------------------------------
// What the assistant's tools read: device state, and the observations the
// scenarios produce. The board's network view recomputes its incidents from
// the scenarios, so they are not stored here.
const acme: Principal = {
  sub: 'seed', email: 'seed@netpulse.io', tenantId: 'acme-networks',
  roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
};
const estate = loadEstate(acme.tenantId);
const inventory = getInventory(acme);
console.log('  writing the network estate...');
await putDeviceStates(acme, allDeviceStates(acme));
let observations = 0;
for (const scenario of buildScenarios(estate)) {
  const pushed = runScenarioFeeds(acme, inventory, scenario.feeds, '2026-09-08T14:30:05.000Z').observations;
  const resolved = resolveLocations(acme, collapseDuplicates(pushed));
  await putObservations(acme, resolved);
  observations += resolved.length;
}
console.log('  network: ' + allDeviceStates(acme).length + ' devices, ' + observations + ' observations');

const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log('\n' + (dryRun ? 'Would make' : 'Made') + ': ' +
  ops.put + ' puts, ' + ops.batchPut + ' batch writes (' + ops.batchItems + ' items), ' +
  ops.get + ' gets, ' + ops.delete + ' deletes, ' + ops.query + ' queries' +
  (dryRun ? '' : ' in ' + seconds + ' s'));
