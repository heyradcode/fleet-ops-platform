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
 * Who is looking at the board.
 *
 * WITH a district: a dispatcher, scoped to that board.
 * WITHOUT one: an operations lead, whose admin role is what grants tenant-wide
 * scope. This is not a detail - it is the rule working. A dispatcher with no
 * district claim does NOT get the whole fleet; scopeFromClaims() gives them
 * driver scope, because widening access has to be a deliberate grant rather
 * than the accident of a missing field. Building the board is how that got
 * proved: the all-districts view came back empty until it signed in as someone
 * actually entitled to it.
 */
function principalFor(districtId?: string): Principal {
  return verifyToken(signDemoToken({
    sub: 'u-board',
    email: districtId ? 'dispatcher@acme-freight.com' : 'lead@meridian.io',
    'custom:tenantId': 'acme-freight',
    'cognito:groups': districtId ? ['dispatcher'] : ['admin'],
    ...(districtId ? { 'custom:district': districtId } : {}),
  }));
}

/** The tenant-wide principal used to compute what the RULES decided. */
function analyst(): Principal {
  return principalFor(undefined);
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

export const inProcessTransport: Transport = {
  async loadBoard(districtId) {
    if (!seeded) { seed(); seeded = true; }

    const principal = principalFor(districtId);
    const { exceptions, incidents, heldBack } = runScenarios(analyst());

    const inScope = (e: { districtId: string }) => !districtId || e.districtId === districtId;

    return {
      // withinScope is the boundary, not the filter - the same function the
      // GraphQL resolver applies, for the same reason.
      drivers: withinScope(principal, allDrivers(principal)),
      territories: allDistricts(principal),
      exceptions: exceptions.filter(inScope),
      incidents: incidents.filter(inScope),
      heldBack: heldBack.filter(inScope),
    } satisfies BoardSnapshot;
  },

  subscribeExceptions(districtId, onException) {
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
