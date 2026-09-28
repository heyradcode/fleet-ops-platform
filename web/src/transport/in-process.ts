/**
 * The in-process transport: the entire backend, running in the browser tab.
 *
 * It imports the same decoders, the same mappers, the same pipeline and the
 * same rules the Lambdas would run. Nothing here is a mock of the backend - it
 * IS the backend, with `src/aws/` standing in for the AWS services underneath.
 *
 * The scenarios are replayed through the real path on load
 * (decode -> map -> collapse -> resolve -> evaluate -> correlate) so the board
 * shows what the RULES decided, not a hand-written list of things that look
 * like alerts. If the corroboration rule changes, this board changes with it.
 */
import type { Transport } from './index.ts';
import type { DeviceStatus, Principal } from '../../../src/platform/types.ts';

import { now } from '../../../src/platform/clock.ts';
import { verifyToken, signDemoToken } from '../../../src/auth/cognito-jwt-verifier.ts';
import {
  loadEstate, getInventory, allDeviceStates,
} from '../../../src/geo/device-repository.ts';
import { withinScope } from '../../../src/platform/tenancy.ts';
import { buildScenarios } from '../../../src/data/scenarios.ts';
import { generateHealthTrace } from '../../../src/data/trace.ts';
import {
  runScenarioFeeds, collapseDuplicates, resolveLocations,
} from '../../../src/pipeline/steps.ts';
import { runAgent } from '../../../src/ai/agent-core.ts';
import { toolSpecsFor } from '../../../src/ai/tools.ts';
import { runAudited } from '../../../src/ai/tool-provider.ts';
import { buildGraph } from '../../../src/graph/store.ts';
import { mockHistory, mockFetch, directory as commsDirectory, DEMO_CLIENT, DEMO_WEBEX_TOKEN, DEMO_BANDWIDTH_USER, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS } from '../../../src/integrations/comms/mock/index.ts';
import { createCommsClient } from '../../../src/integrations/comms/client.ts';
import { commsConfigFor } from '../../../src/integrations/comms/config.ts';
import { backfillCommsBaselines, runCommsPoll } from '../../../src/integrations/comms/poll.ts';
import { commsVisibleTo } from '../../../src/integrations/comms/store.ts';
import { setHelixClientFactory } from '../../../src/integrations/comms/helix.ts';
import { knowledgeBase } from '../../../src/ai/knowledge-base.ts';
import { putObservations, putDeviceStates } from '../../../src/platform/repository.ts';
import { loadRunbooksFromBundle } from './runbooks.browser.ts';
import {
  auditSnapshot, boardSnapshot, commsSnapshot, seedDemoWorld, tenantScenarios, SCENARIO_AT,
} from '../../../src/api/board-api.ts';

/**
 * Seed the platform primitives before anything reads them.
 *
 * The same three calls `demo.ts` makes. Without them the board would render
 * different device ids and different incident ids on every reload, which makes
 * it impossible to tell a real change from noise while building.
 */
function seed(): void {
  seedDemoWorld();
}

let seeded = false;

function ensureSeeded(): void {
  if (!seeded) { seed(); seeded = true; }
}

/**
 * The signed-in principal.
 *
 * Null until sign-in completes, and the board does not render before then - so
 * there is no path that reads estate data without a verified token behind it.
 */
let session: Principal | null = null;

/**
 * The caller. Comes from the signed-in session, never from the UI.
 *
 * Before sign-in existed this was fabricated here, which meant the board's
 * scope was asserted rather than demonstrated. Now a Dallas operator cannot
 * reach Phoenix because their TOKEN does not say they may, and the same
 * withinScope() the GraphQL resolver applies is what enforces it.
 */
function caller(): Principal {
  if (!session) {
    throw new Error('No session. The board must not render before sign-in.');
  }
  return session;
}

/**
 * A tenant-wide principal, used only to compute what the RULES decided across
 * the whole estate before the caller's scope narrows it.
 *
 * Deriving it from the session's own tenant rather than hard-coding one keeps
 * the tenant boundary intact: a Northwind user computes Northwind's alarms.
 */
function analyst(): Principal {
  return verifyToken(signDemoToken({
    sub: 'rules-evaluator',
    email: 'rules@' + caller().tenantId,
    'custom:tenantId': caller().tenantId,
    'cognito:groups': ['admin'],
  }));
}

/**
 * The agent needs the same data the board shows, in the repository where its
 * tools look for it. Populating it once on demand keeps the board's first
 * paint fast - nobody waits for an embedding index to build before seeing the
 * state of their estate.
 */
let agentReady: Promise<void> | undefined;

function prepareAgent(): Promise<void> {
  agentReady ??= (async () => {
    // The browser half of the runbook registry, loaded HERE rather than at
    // startup. Two reasons: the board's first paint should not wait on a corpus
    // it does not draw, and `import.meta.glob` is a Vite build-time feature -
    // calling it during seed() made the whole transport unloadable outside
    // Vite, which cost the ability to test it under `node --test`.
    //
    // Without this call the knowledge base throws on first retrieval,
    // deliberately loudly: a silently empty knowledge base makes the agent
    // answer "no runbook matched" to everything, which looks like a retrieval
    // bug and is actually a wiring one.
    loadRunbooksFromBundle();

    const principal = analyst();
    const estate = loadEstate(principal.tenantId);
    const inventory = getInventory(principal);

    await putDeviceStates(principal, allDeviceStates(principal));

    for (const scenario of buildScenarios(estate)) {
      const pushed = runScenarioFeeds(principal, inventory, scenario.feeds, SCENARIO_AT).observations;
      await putObservations(principal, resolveLocations(principal, collapseDuplicates(pushed)));
    }

    await knowledgeBase.ingestRunbooks(principal.tenantId);
  })();
  return agentReady;
}

/**
 * One comms poll per tenant per page load, against the vendor mocks - which
 * answer the REAL hostnames through `mockFetch`, in the tab. The same
 * runCommsPoll a scheduled Lambda would run, writing to the same store the
 * agent's tools read, so the board and the assistant cannot disagree.
 */
const commsPolled = new Map<string, Promise<void>>();

/**
 * The agent's Helix lookups (recentChanges) go through a registry; the board
 * fills it with the mock, per tenant that runs Helix. Created lazily - no
 * client exists until a Helix tenant actually asks.
 */
const helixClients = new Map<string, ReturnType<typeof createCommsClient>>();
setHelixClientFactory((tenantId) => {
  if (!commsConfigFor(tenantId)?.helix) return undefined;
  let c = helixClients.get(tenantId);
  if (!c) {
    c = createCommsClient({ tenantId, fetch: mockFetch, credentials: { helix: { ...DEMO_HELIX_USER } } });
    helixClients.set(tenantId, c);
  }
  return c;
});

function ensureCommsPolled(principal: Principal): Promise<void> {
  let done = commsPolled.get(principal.tenantId);
  if (!done) {
    const config = commsConfigFor(principal.tenantId)!;
    const client = createCommsClient({
      tenantId: principal.tenantId,
      fetch: mockFetch,
      credentials: {
        entra: { tenantId: commsDirectory().entraTenantId, ...DEMO_CLIENT },
        genesys: { ...DEMO_CLIENT },
        webex: { token: DEMO_WEBEX_TOKEN },
        bandwidth: { ...DEMO_BANDWIDTH_USER },
        helix: { ...DEMO_HELIX_USER },
        kurmi: { ...DEMO_KURMI_USER },
        starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
      },
    });
    // Eight weeks of baseline first, so the anomaly view has history to
    // judge against - read "as at" each past week through the mock harness.
    const at = now();
    done = backfillCommsBaselines(principal, client, config, at, 8, mockHistory)
      .then(() => runCommsPoll(principal, client, config, at))
      // The knowledge graph after the poll, as `pnpm seed:aws` does: it
      // counts the people the poll just placed. Without it, every candidate
      // cause on the comms view would say "the graph has not been built".
      .then(() => buildGraph(principal))
      .then(() => undefined);
    commsPolled.set(principal.tenantId, done);
  }
  return done;
}

export const inProcessTransport: Transport = {
  setSession(principal) {
    session = principal;
  },

  async loadBoard(siteId) {
    ensureSeeded();
    // The same function the board API serves from Lambda, so the offline
    // board and the deployed one cannot disagree about what the rules
    // decided or about what this caller's scope lets them see.
    return boardSnapshot(caller(), siteId);
  },

  async askAgent(question, onStep) {
    ensureSeeded();
    await prepareAgent();

    // The agent runs with the CALLER's principal, never a privileged one. An
    // operator scoped to Dallas gets an assistant scoped to Dallas, and the
    // tools enforce that themselves rather than trusting the prompt.
    const principal = caller();
    const result = await runAgent({
      question,
      principal,
      // Per caller: a comms tenant's assistant also gets the comms tools.
      // For every network-only tenant this is exactly TOOL_SPECS, as before.
      tools: toolSpecsFor(principal, { readOnly: false }),
      // Recorded, so the audit view has something to show offline. A
      // DEMONSTRATION of the trail, labelled 'tab': a record kept in the
      // caller's own browser is one they could edit. The trail that counts
      // is the MCP server's, on AWS.
      callTool: async (name, input) => (await runAudited(name, input, principal, 'tab')).text,
      onStep,
    });
    return { ...result, servedBy: { host: 'tab', model: 'offline', turn: 1 } };
  },

  async loadComms() {
    ensureSeeded();
    const principal = caller();
    if (!commsVisibleTo(principal)) return null;

    // The CALLER polls - a tenant-wide principal, which is exactly who
    // commsVisibleTo admits - so there is no privileged principal involved.
    await ensureCommsPolled(principal);
    return commsSnapshot(principal);
  },

  async loadAudit() {
    ensureSeeded();
    return auditSnapshot(caller());
  },

  subscribeHealth(siteId, onTick) {
    ensureSeeded();

    const principal = caller();
    // The same boundary as loadBoard: the token decides which devices exist,
    // and the site is a view on top of that. A frame never carries a device the
    // caller could not have loaded.
    const visible = new Set(
      withinScope(principal, allDeviceStates(principal))
        .filter((d) => !siteId || d.siteId === siteId)
        .map((d) => d.deviceId),
    );

    const estate = loadEstate(principal.tenantId);
    const trace = generateHealthTrace(estate);

    let i = 0;
    let cancelled = false;

    const emit = () => {
      if (cancelled) return;
      const frame = trace.frames[i % trace.frames.length];
      const status = new Map<string, DeviceStatus>();
      for (const [deviceId, s] of frame.status) {
        if (visible.has(deviceId)) status.set(deviceId, s);
      }
      onTick({
        at: frame.at,
        index: i % trace.frames.length,
        total: trace.frames.length,
        status,
        rootCauseDeviceId: trace.rootCauseDeviceId,
      });
      i++;
    };

    // First frame immediately, so the estate is drawn before the interval
    // fires; then one every 1.5s. Thirty simulated minutes in ninety real
    // seconds: fast enough to watch a cascade spread, slow enough to read.
    emit();
    const timer = setInterval(emit, 1500);

    return () => { cancelled = true; clearInterval(timer); };
  },

  subscribeAlarms(siteId, onAlarm) {
    // Seed here too. This path used to rely on loadBoard() having run first,
    // which is true today and is not a guarantee - an effect-order change, or a
    // component that subscribes without loading, would break it silently.
    ensureSeeded();

    // The offline stand-in for the AppSync WebSocket. The real one is a
    // filtered subscription; the filter is applied HERE for the same reason
    // AppSync applies it server-side - a Phoenix operator should never receive
    // Dallas traffic, for cost and for confidentiality.
    let cancelled = false;

    const { alarms } = tenantScenarios(caller());
    const queue = alarms.filter((a) => !siteId || a.siteId === siteId);

    let i = 0;
    const timer = setInterval(() => {
      if (cancelled || i >= queue.length) return;
      onAlarm(queue[i++]);
    }, 2400);

    return () => { cancelled = true; clearInterval(timer); };
  },
};
