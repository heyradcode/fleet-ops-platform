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
import type { BoardSnapshot, CommsSnapshot, HealthTick, Transport } from './index.ts';
import type { Alarm, DeviceStatus, Incident, Principal } from '../../../src/platform/types.ts';

import { setClock, fixedClock, now } from '../../../src/platform/clock.ts';
import { setRandom, seededRandom } from '../../../src/platform/random.ts';
import { setUuid, seededUuid } from '../../../src/platform/crypto.ts';
import { verifyToken, signDemoToken } from '../../../src/auth/cognito-jwt-verifier.ts';
import {
  loadEstate, getInventory, allDeviceStates, allSites,
} from '../../../src/geo/device-repository.ts';
import { withinScope } from '../../../src/platform/tenancy.ts';
import { buildScenarios } from '../../../src/data/scenarios.ts';
import { generateHealthTrace } from '../../../src/data/trace.ts';
import { setProber, resetProber, probeEstate } from '../../../src/integrations/probe.ts';
import {
  runScenarioFeeds, collapseDuplicates, resolveLocations, evaluate, detectIncidents,
} from '../../../src/pipeline/steps.ts';
import { runAgent } from '../../../src/ai/agent-core.ts';
import { toolSpecsFor } from '../../../src/ai/tools.ts';
import { mockHistory, mockFetch, directory as commsDirectory, DEMO_CLIENT, DEMO_WEBEX_TOKEN, DEMO_BANDWIDTH_USER, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS } from '../../../src/integrations/comms/mock/index.ts';
import { createCommsClient } from '../../../src/integrations/comms/client.ts';
import { commsConfigFor } from '../../../src/integrations/comms/config.ts';
import { backfillCommsBaselines, runCommsPoll } from '../../../src/integrations/comms/poll.ts';
import { latestAnomalies } from '../../../src/integrations/comms/anomalies.ts';
import {
  commsAlarms, commsIncidents, commsPhones, commsResolvedIncidents, commsVisibleTo, commsWorkforce,
} from '../../../src/integrations/comms/store.ts';
import { loadHealth } from '../../../src/integrations/comms/health.ts';
import { setHelixClientFactory } from '../../../src/integrations/comms/helix.ts';
import { buildDailyBrief } from '../../../src/reporting/daily-brief.ts';
import { knowledgeBase } from '../../../src/ai/knowledge-base.ts';
import { putObservations, putDeviceStates } from '../../../src/platform/repository.ts';
import { loadRunbooksFromBundle } from './runbooks.browser.ts';

/**
 * Seed the platform primitives before anything reads them.
 *
 * The same three calls `demo.ts` makes. Without them the board would render
 * different device ids and different incident ids on every reload, which makes
 * it impossible to tell a real change from noise while building.
 */
function seed(): void {
  setClock(fixedClock());
  const rng = seededRandom();
  setRandom(rng);
  setUuid(seededUuid(rng));
  loadEstate();
}

/** The instant every scenario is replayed at. Fixed, like everything else. */
const SCENARIO_AT = '2026-09-08T14:30:05.000Z';

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

/** Run every scenario through the real pipeline and collect what it decided. */
function runScenarios(principal: Principal) {
  const estate = loadEstate(principal.tenantId);
  const inventory = getInventory(principal);

  const alarms: Alarm[] = [];
  const incidents: Incident[] = [];

  for (const scenario of buildScenarios(estate)) {
    // The prober is part of the scenario, because the external plane is what
    // makes half of these corroborate at all. Reset afterwards so one
    // scenario's outage does not leak into the next.
    if (scenario.unreachable) {
      const down = new Set(scenario.unreachable);
      setProber((deviceId) => !down.has(deviceId));
    } else {
      resetProber();
    }

    const pushed = runScenarioFeeds(principal, inventory, scenario.feeds, SCENARIO_AT).observations;
    const probed = scenario.unreachable
      ? probeEstate(principal, inventory)
        .filter((o) => scenario.unreachable!.includes(o.deviceId))
      : [];

    const enriched = resolveLocations(principal, collapseDuplicates([...pushed, ...probed]));
    const raised = evaluate(principal, enriched);
    alarms.push(...raised);
    incidents.push(...detectIncidents(principal, raised));
  }
  resetProber();

  // An alarm whose id appears in no incident fired but was not corroborated.
  // The board shows these dimmed rather than hiding them - see the note on
  // `.is-noise` in styles.css.
  const paged = new Set(incidents.flatMap((i) => i.alarmIds));
  const heldBack = alarms.filter((a) => !paged.has(a.alarmId));

  return { alarms, incidents, heldBack };
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

    putDeviceStates(principal, allDeviceStates(principal));

    for (const scenario of buildScenarios(estate)) {
      const pushed = runScenarioFeeds(principal, inventory, scenario.feeds, SCENARIO_AT).observations;
      putObservations(principal, resolveLocations(principal, collapseDuplicates(pushed)));
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

    const principal = caller();
    const { alarms, incidents, heldBack } = runScenarios(analyst());

    // TWO STEPS, and both are needed. withinScope() is the BOUNDARY, derived
    // from the token; siteId is the caller's chosen VIEW. Applying only the
    // first meant a Dallas operator who asked for Phoenix got Dallas's devices
    // rendered under a Phoenix heading - not a leak, since scope had already
    // excluded Phoenix, but wrong in a way that would make someone distrust the
    // board the moment they noticed.
    //
    // Query.devices in the GraphQL resolver does exactly this pair. Every entry
    // point to the same data has to, which is the argument for both living
    // behind the same two functions rather than being reimplemented.
    const atSite = (x: { siteId: string }) => !siteId || x.siteId === siteId;

    return {
      devices: withinScope(principal, allDeviceStates(principal)).filter(atSite),
      sites: allSites(principal),
      alarms: alarms.filter(atSite),
      incidents: incidents.filter(atSite),
      heldBack: heldBack.filter(atSite),
    } satisfies BoardSnapshot;
  },

  async askAgent(question) {
    ensureSeeded();
    await prepareAgent();

    // The agent runs with the CALLER's principal, never a privileged one. An
    // operator scoped to Dallas gets an assistant scoped to Dallas, and the
    // tools enforce that themselves rather than trusting the prompt.
    return runAgent({
      question,
      principal: caller(),
      // Per caller: a comms tenant's assistant also gets the comms tools.
      // For every network-only tenant this is exactly TOOL_SPECS, as before.
      tools: toolSpecsFor(caller(), { readOnly: false }),
    });
  },

  async loadComms() {
    ensureSeeded();
    const principal = caller();
    if (!commsVisibleTo(principal)) return null;

    // The CALLER polls - a tenant-wide principal, which is exactly who
    // commsVisibleTo admits - so there is no privileged principal involved.
    await ensureCommsPolled(principal);
    return {
      workforce: commsWorkforce(principal)!,
      incidents: commsIncidents(principal),
      heldBack: commsAlarms(principal).filter((a) => !a.corroborated),
      health: loadHealth(principal),
      resolved: commsResolvedIncidents(principal),
      phones: commsPhones(principal),
      // The network incidents the board's network view shows, so the brief and
      // the board cannot disagree about what is open.
      brief: await buildDailyBrief(principal, now(), { networkIncidents: runScenarios(analyst()).incidents }),
      anomalies: latestAnomalies(principal)?.anomalies ?? [],
    } satisfies CommsSnapshot;
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

    const { alarms } = runScenarios(analyst());
    const queue = alarms.filter((a) => !siteId || a.siteId === siteId);

    let i = 0;
    const timer = setInterval(() => {
      if (cancelled || i >= queue.length) return;
      onAlarm(queue[i++]);
    }, 2400);

    return () => { cancelled = true; clearInterval(timer); };
  },
};
