/**
 * The in-process transport: the entire backend, running in the browser tab.
 *
 * It imports the same resolvers, the same pipeline and the same rules the
 * Lambdas would run. Nothing here is a mock of the backend - it IS the backend,
 * with `src/aws/` standing in for the AWS services underneath.
 *
 * The scenarios are replayed through the real path on load
 * (normalise -> resolve -> derive -> evaluate -> detect) so the board shows
 * what the RULES decided, not a hand-written list of things that look like
 * alerts. If the corroboration rule changes, this board changes with it.
 */
import type { BoardSnapshot, Transport } from './index.ts';
import type { Exception, Principal } from '../../../src/platform/types.ts';

import { setClock, fixedClock } from '../../../src/platform/clock.ts';
import { setRandom, seededRandom } from '../../../src/platform/random.ts';
import { setUuid, seededUuid } from '../../../src/platform/crypto.ts';
import { verifyToken, signDemoToken } from '../../../src/auth/cognito-jwt-verifier.ts';
import { allDrivers, allDistricts } from '../../../src/geo/driver-repository.ts';
import { withinScope } from '../../../src/platform/tenancy.ts';
import { SCENARIOS } from '../../../src/data/scenarios.ts';
import {
  normaliseAll, resolveTerritory, deriveRouteAdherence, evaluate, detectIncidents,
} from '../../../src/pipeline/steps.ts';
import { runAgent } from '../../../src/ai/agent-core.ts';
import { TOOL_SPECS } from '../../../src/ai/tools.ts';
import { knowledgeBase } from '../../../src/ai/knowledge-base.ts';
import { putTelemetry, putDrivers } from '../../../src/platform/repository.ts';
import { loadRunbooksFromBundle } from './runbooks.browser.ts';

/**
 * Seed the platform primitives before anything reads them.
 *
 * The same three calls `demo.ts` makes. Without them the board would render
 * different driver positions and different incident ids on every reload, which
 * makes it impossible to tell a real change from noise while building.
 */
function seed(): void {
  setClock(fixedClock());
  const rng = seededRandom();
  setRandom(rng);
  setUuid(seededUuid(rng));
}

let seeded = false;

/**
 * The signed-in principal.
 *
 * Null until sign-in completes, and the board does not render before then -
 * so there is no path that reads fleet data without a verified token behind it.
 */
let session: Principal | null = null;

/**
 * The caller. Comes from the signed-in session, never from the UI.
 *
 * Before sign-in existed this was fabricated here, which meant the board's
 * scope was asserted rather than demonstrated. Now a Dallas dispatcher cannot
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
 * the whole fleet before the caller's scope narrows it.
 *
 * Deriving it from the session's own tenant rather than hard-coding one keeps
 * the tenant boundary intact: a Northstar user computes Northstar's exceptions.
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
  const exceptions: Exception[] = [];
  const incidents = [];

  for (const scenario of SCENARIOS) {
    const collected = scenario.build(principal.tenantId).map((raw) => ({ raw }));
    const readings = deriveRouteAdherence(
      resolveTerritory(principal, normaliseAll(principal, collected)),
    );
    const raised = evaluate(principal, readings);
    exceptions.push(...raised);
    incidents.push(...detectIncidents(principal, raised));
  }

  // An exception whose id appears in no incident fired but was not
  // corroborated. The board shows these dimmed rather than hiding them - see
  // the note on `.is-noise` in styles.css.
  const paged = new Set(incidents.flatMap((i) => i.exceptionIds));
  const heldBack = exceptions.filter((e) => !paged.has(e.exceptionId));

  return { exceptions, incidents, heldBack };
}

/**
 * The agent needs the same data the board shows, in the repository where its
 * tools look for it. Populating it once on demand keeps the board's first
 * paint fast - nobody waits for an embedding index to build before seeing
 * where their trucks are.
 */
let agentReady: Promise<void> | undefined;

function prepareAgent(): Promise<void> {
  agentReady ??= (async () => {
    // The browser half of the runbook registry, loaded HERE rather than at
    // startup. Two reasons: the board's first paint should not wait on a
    // corpus it does not draw, and `import.meta.glob` is a Vite build-time
    // feature - calling it during seed() made the whole transport unloadable
    // outside Vite, which cost the ability to test it under `node --test`.
    //
    // Without this call the knowledge base throws on first retrieval,
    // deliberately loudly: a silently empty knowledge base makes the agent
    // answer "no runbook matched" to everything, which looks like a retrieval
    // bug and is actually a wiring one.
    loadRunbooksFromBundle();

    const principal = analyst();
    putDrivers(principal, allDrivers(principal));

    for (const scenario of SCENARIOS) {
      const collected = scenario.build(principal.tenantId).map((raw) => ({ raw }));
      putTelemetry(principal, deriveRouteAdherence(
        resolveTerritory(principal, normaliseAll(principal, collected)),
      ));
    }

    await knowledgeBase.ingestRunbooks(principal.tenantId);
  })();
  return agentReady;
}

export const inProcessTransport: Transport = {
  setSession(principal) {
    session = principal;
  },

  async loadBoard(districtId) {
    if (!seeded) { seed(); seeded = true; }

    const principal = caller();
    const { exceptions, incidents, heldBack } = runScenarios(analyst());

    // TWO STEPS, and both are needed. withinScope() is the BOUNDARY, derived
    // from the token; districtId is the caller's chosen VIEW. Applying only
    // the first meant a Dallas dispatcher who asked for Phoenix got Dallas's
    // sixteen drivers rendered under a Phoenix heading - not a leak, since
    // scope had already excluded Phoenix, but wrong in a way that would make
    // someone distrust the board the moment they noticed.
    //
    // Query.drivers in the GraphQL resolver does exactly this pair. Every
    // entry point to the same data has to, which is the argument for both
    // living behind the same two functions rather than being reimplemented.
    const inDistrict = (d: { districtId: string }) => !districtId || d.districtId === districtId;

    return {
      drivers: withinScope(principal, allDrivers(principal)).filter(inDistrict),
      territories: allDistricts(principal),
      exceptions: exceptions.filter(inDistrict),
      incidents: incidents.filter(inDistrict),
      heldBack: heldBack.filter(inDistrict),
    } satisfies BoardSnapshot;
  },

  async askAgent(question, districtId) {
    if (!seeded) { seed(); seeded = true; }
    await prepareAgent();

    // The agent runs with the CALLER's principal, never a privileged one. A
    // dispatcher scoped to Dallas gets an assistant scoped to Dallas, and the
    // tools enforce that themselves rather than trusting the prompt.
    return runAgent({
      question,
      principal: caller(),
      tools: TOOL_SPECS,
    });
  },

  subscribeExceptions(districtId, onException) {
    // Seed here too. This path used to rely on loadBoard() having run first,
    // which is true today and is not a guarantee - an effect-order change, or
    // a component that subscribes without loading, would break it silently.
    if (!seeded) { seed(); seeded = true; }

    // The offline stand-in for the AppSync WebSocket. The real one is a
    // filtered subscription; the filter is applied HERE for the same reason
    // AppSync applies it server-side - a Phoenix dispatcher should never
    // receive Dallas traffic, for cost and for confidentiality.
    let cancelled = false;

    const { exceptions } = runScenarios(analyst());
    const queue = exceptions.filter((e) => !districtId || e.districtId === districtId);

    let i = 0;
    const timer = setInterval(() => {
      if (cancelled || i >= queue.length) return;
      onException(queue[i++]);
    }, 2400);

    return () => { cancelled = true; clearInterval(timer); };
  },
};
