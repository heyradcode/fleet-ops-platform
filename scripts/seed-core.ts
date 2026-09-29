/**
 * What `pnpm seed:aws` writes, as a function - so the local MCP server
 * (scripts/mcp-local.ts) can fill its in-memory table with EXACTLY what the
 * deployed tools read from DynamoDB. Two copies of this would drift, and the
 * symptom would be the local server and AWS answering the same question
 * differently for no visible reason.
 *
 * Writes to whatever `mainTable` currently forwards to: the caller picks the
 * store (the SDK adapter, a counted wrapper, or the default in-memory table).
 * The resumable-backfill rules are explained in seed-aws.ts, where they bite.
 *
 * Node-only by location, not by content: it lives in scripts/ because only
 * Node entry points seed anything.
 */
import { mainTable } from '../src/aws/dynamodb.ts';
import { setClock, fixedClock, now } from '../src/platform/clock.ts';
import { setRandom, seededRandom } from '../src/platform/random.ts';
import { setUuid, seededUuid } from '../src/platform/crypto.ts';
import { pk } from '../src/platform/tenancy.ts';
import type { Principal } from '../src/platform/types.ts';
import { loadEstate, getInventory, allDeviceStates } from '../src/geo/device-repository.ts';
import { buildScenarios } from '../src/data/scenarios.ts';
import { runScenarioFeeds, collapseDuplicates, resolveLocations } from '../src/pipeline/steps.ts';
import { putDeviceStates, putObservations } from '../src/platform/repository.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_CUCM_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN,
  directory, mockFetch, mockHistory,
} from '../src/integrations/comms/mock/index.ts';
import { createCommsClient } from '../src/integrations/comms/client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from '../src/integrations/comms/config.ts';
import { backfillCommsBaselines, runCommsPoll } from '../src/integrations/comms/poll.ts';
import { buildGraph } from '../src/graph/store.ts';

/** Weeks of baseline history - the anomaly detector's 4-week minimum, with room. */
export const BACKFILL_WEEKS = 8;

export async function seedDemoData(log: (line: string) => void = () => {}): Promise<void> {
  // The same seeding the board and the demo do: fixed clock, seeded ids. The
  // mocks' activity is anchored to that clock, so this is also what makes the
  // stored incidents the ones the offline board shows.
  setClock(fixedClock());
  const rng = seededRandom();
  setRandom(rng);
  setUuid(seededUuid(rng));
  loadEstate();
  const started = performance.now();

  // --- The comms tenant ------------------------------------------------------
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
      kurmi: { ...DEMO_KURMI_USER }, cucm: { ...DEMO_CUCM_USER },
      starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
    },
  });

  const elapsed = () => ((performance.now() - started) / 1000).toFixed(1) + 's';
  const progressKey = { PK: pk(hhs, 'COMMS'), SK: 'BACKFILL#PROGRESS' };
  const record = await mainTable.get(progressKey.PK, progressKey.SK);
  const done = new Set<number>((record?.weeksDone as number[] | undefined) ?? []);
  const hasBaselines = (await mainTable.query({ pk: pk(hhs, 'BASELINE'), limit: 1 })).length > 0;

  if (!record && hasBaselines) {
    // Seeded by a version that kept no record. It may have finished or been
    // stopped half-way; there is no way to tell, and backfilling again would
    // double-count whatever did land. Say so rather than guess.
    log('  baselines exist from an earlier seed with no progress record - backfill skipped.\n' +
      '  If that seed was interrupted, delete the TENANT#' + HHS_DEMO_TENANT + '#BASELINE partition and re-run.');
  } else if (done.size >= BACKFILL_WEEKS) {
    log('  baselines complete (' + BACKFILL_WEEKS + ' weeks) - backfill skipped');
  } else {
    log('  backfilling ' + (BACKFILL_WEEKS - done.size) + ' of ' + BACKFILL_WEEKS + ' weeks' + (done.size ? ' (resuming)' : '') + '...');
    const points = await backfillCommsBaselines(hhs, client, config, now(), BACKFILL_WEEKS, mockHistory, {
      done,
      afterWeek: async (weeksAgo, n) => {
        done.add(weeksAgo);
        // AFTER the week's writes - recording it first would let a crash
        // leave a week marked done that never landed.
        await mainTable.put({ ...progressKey, entity: 'BackfillProgress', weeksDone: [...done].sort((a, b) => a - b), at: now() });
        log('    week -' + weeksAgo + ': ' + n + ' points  [' + elapsed() + ']');
      },
    });
    log('  backfilled ' + points + ' baseline points');
  }
  log('  polling the comms sources...');
  const poll = await runCommsPoll(hhs, client, config, now());
  log('  comms poll [' + elapsed() + ']: ' + poll.incidents.length + ' open incident(s), ' + poll.resolved.length + ' resolved, ' +
    poll.anomalies.length + ' anomal' + (poll.anomalies.length === 1 ? 'y' : 'ies'));
  // The poll's backup - reported, never fatal (archive.ts).
  const a = poll.archive;
  log('  comms archive: ' + (a.status === 'written'
    ? a.objects.length + ' objects, ' + Math.round(a.bytes / 1024) + ' KB -> ' + (a.objects[0] ?? '').replace(/\/comms\/.*$/, '/comms/')
    : a.status.toUpperCase() + ' - ' + (a.status === 'refused' ? a.reason : a.error)));

  // --- The network tenant ----------------------------------------------------
  // What the assistant's tools read: device state, and the observations the
  // scenarios produce. The board's network view recomputes its incidents from
  // the scenarios, so they are not stored here.
  const acme: Principal = {
    sub: 'seed', email: 'seed@netpulse.io', tenantId: 'acme-networks',
    roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  const estate = loadEstate(acme.tenantId);
  const inventory = getInventory(acme);
  log('  writing the network estate...');
  await putDeviceStates(acme, allDeviceStates(acme));
  let observations = 0;
  for (const scenario of buildScenarios(estate)) {
    const pushed = runScenarioFeeds(acme, inventory, scenario.feeds, '2026-09-08T14:30:05.000Z').observations;
    const resolved = resolveLocations(acme, collapseDuplicates(pushed));
    await putObservations(acme, resolved);
    observations += resolved.length;
  }
  log('  network: ' + allDeviceStates(acme).length + ' devices, ' + observations + ' observations');

  // --- The knowledge graph ---------------------------------------------------
  // LAST: it loads the HHS estate, and nothing above should see that. Derived
  // from the estate, the tenant's tables and the workforce counts the poll
  // just stored, so it is built after them. Re-runnable: a rebuild overwrites
  // by key and removes only what the sources dropped.
  const graph = await buildGraph(hhs);
  log('  knowledge graph: ' + graph.nodes + ' nodes, ' + graph.edges + ' edges' +
    (graph.removed ? ', ' + graph.removed + ' stale items removed' : ''));
}
