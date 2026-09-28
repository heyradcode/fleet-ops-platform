/**
 * ---------------------------------------------------------------------------
 * The board's API: the views that read real data, over HTTP
 * ---------------------------------------------------------------------------
 *   GET /board?siteId=   the network view - what the RULES decided, scoped
 *   GET /comms           the voice and contact-centre view, from the store
 *   GET /audit           the assistant's tool calls - admins only
 *
 * ONE IMPLEMENTATION, TWO CALLERS. `boardSnapshot` and `commsSnapshot` are
 * what the in-process transport calls in the tab AND what this handler calls
 * in Lambda. The board cannot show one thing offline and another deployed,
 * because there is no second copy of the logic to drift.
 *
 * What is NOT here, deliberately: the health replay, the live alarm feed and
 * the assistant. The first two play back recorded scenarios - there is no
 * data behind them to serve - and the assistant runs on the offline Bedrock
 * stand-in (aws/bedrock.ts), so moving it into a Lambda would add a deploy
 * without making it any more real. They stay in the tab until Bedrock is
 * wired, which is its own cost decision.
 *
 * THE TOKEN IS VERIFIED HERE, EVERY REQUEST, even though API Gateway's JWT
 * authorizer checked it first. The gateway checks signature, issuer, expiry
 * and client id; it does NOT check `token_use` (an ID token from the same
 * pool passes it) or that a tenant claim exists. Those are checks 4 and 7 of
 * the seven in auth/cognito-jwt-verifier.ts, and the second is the tenant
 * boundary itself. The gateway is the cheap filter that keeps anonymous
 * traffic from invoking - and billing - the Lambda at all; this is the check.
 *
 * DETERMINISM, PER REQUEST. The network view replays scenarios through the
 * pipeline, which draws from the seeded random source - and the estate is
 * regenerated whenever the tenant changes. A warm Lambda serving an HHS
 * request and then an Acme one would otherwise answer Acme from a random
 * state the HHS request had advanced. So every request reseeds, exactly as a
 * fresh board tab does. That is safe only because a Lambda container handles
 * ONE request at a time; in a server with concurrent requests this global
 * reset would be a race, and the world would need to be per request.
 */
import type {
  Alarm, DeviceState, Incident, Principal, Site,
} from '../platform/types.ts';
import { setClock, fixedClock, now } from '../platform/clock.ts';
import { setRandom, seededRandom } from '../platform/random.ts';
import { setUuid, seededUuid } from '../platform/crypto.ts';
import { OutOfScopeError, withinScope } from '../platform/tenancy.ts';
import { log } from '../platform/logger.ts';
import { loadEstate, getInventory, allDeviceStates, allSites } from '../geo/device-repository.ts';
import { buildScenarios } from '../data/scenarios.ts';
import { setProber, resetProber, probeEstate } from '../integrations/probe.ts';
import {
  runScenarioFeeds, collapseDuplicates, resolveLocations, evaluate, detectIncidents,
} from '../pipeline/steps.ts';
import type { CommsAlarm, CommsIncident } from '../integrations/comms/incidents.ts';
import {
  commsAlarms, commsIncidents, commsPhones, commsResolvedIncidents, commsVisibleTo, commsWorkforce,
  type WorkforceSummary,
} from '../integrations/comms/store.ts';
import { loadHealth, type IntegrationHealth } from '../integrations/comms/health.ts';
import type { PhoneInventory } from '../integrations/comms/kurmi.ts';
import { latestAnomalies, type CommsAnomaly } from '../integrations/comms/anomalies.ts';
import { buildDailyBrief, type Brief } from '../reporting/daily-brief.ts';
import type { ApiGatewayEvent, ApiGatewayResult } from './rest-handler.ts';
import {
  recentAudit, summariseAudit, AUDIT_RETENTION_DAYS, type AuditEntry, type AuditSummary,
} from '../ai/audit.ts';
import { causesForIncidents, type CandidateCauses } from '../graph/correlate.ts';

// ---------------------------------------------------------------------------
// The snapshots - the contract the board renders
// ---------------------------------------------------------------------------

export type BoardSnapshot = {
  devices: DeviceState[];
  sites: Site[];
  alarms: Alarm[];
  incidents: Incident[];
  /** Alarms that fired but were not corroborated, so nobody was paged. */
  heldBack: Alarm[];
};

/**
 * The voice and contact-centre view: Teams, Genesys, Webex.
 *
 * Counts, never a roster - the same boundary the store keeps. A board that
 * listed named people by building would be a directory of where everyone
 * sits, which is not something an operations screen needs to be.
 */
export type CommsSnapshot = {
  workforce: WorkforceSummary;
  incidents: CommsIncident[];
  /** Raised but not corroborated, with the reason. Shown dimmed, as on the network side. */
  heldBack: CommsAlarm[];
  /** Is every feed answering, and is what it says usable. */
  health?: IntegrationHealth;
  /** Recently resolved, newest first. Shown dimmed below the open ones. */
  resolved: CommsIncident[];
  /** Cisco desk phones from Kurmi - devices, shown beside the workforce, never in it. */
  phones?: PhoneInventory;
  /** The executive daily brief, built from exactly what this snapshot shows. */
  brief: Brief;
  /** Unusual for the subject and hour of week. Early warnings and context - never alarms. */
  anomalies: CommsAnomaly[];
  /**
   * Per open incident id: what the knowledge graph puts beside it - the
   * network alarms and incidents in the same building, around that time.
   * CANDIDATES, attached after both sets of rules decided; see correlate.ts.
   */
  causes: Record<string, CandidateCauses>;
};

// ---------------------------------------------------------------------------
// The world the views are computed in
// ---------------------------------------------------------------------------

/** The instant every scenario is replayed at. Fixed, like everything else. */
export const SCENARIO_AT = '2026-09-08T14:30:05.000Z';

/**
 * Seed the platform primitives, as demo.ts, the board and the seed script do.
 * Without it device order, alarm ids and incident ids differ run to run, and
 * a real change cannot be told from noise.
 */
export function seedDemoWorld(): void {
  setClock(fixedClock());
  const rng = seededRandom();
  setRandom(rng);
  setUuid(seededUuid(rng));
  loadEstate(undefined, true);
}

/**
 * A tenant-wide principal for the caller's OWN tenant, used only to compute
 * what the rules decided across the estate before the caller's scope narrows
 * it. Never returned, never used to read: derived from the caller's tenant,
 * so a Northwind user computes Northwind's alarms and nobody else's.
 */
function rulesPrincipal(caller: Principal): Principal {
  return {
    sub: 'rules-evaluator', email: 'rules@' + caller.tenantId, tenantId: caller.tenantId,
    roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: caller.identityProvider,
  };
}

/** Run every scenario through the real pipeline and collect what it decided. */
export function runScenarios(principal: Principal): { alarms: Alarm[]; incidents: Incident[]; heldBack: Alarm[] } {
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
      ? probeEstate(principal, inventory).filter((o) => scenario.unreachable!.includes(o.deviceId))
      : [];

    const enriched = resolveLocations(principal, collapseDuplicates([...pushed, ...probed]));
    const raised = evaluate(principal, enriched);
    alarms.push(...raised);
    incidents.push(...detectIncidents(principal, raised));
  }
  resetProber();

  // An alarm whose id appears in no incident fired but was not corroborated.
  // The board shows these dimmed rather than hiding them.
  const paged = new Set(incidents.flatMap((i) => i.alarmIds));
  const heldBack = alarms.filter((a) => !paged.has(a.alarmId));
  return { alarms, incidents, heldBack };
}

/**
 * What the rules decided across the caller's tenant - before scope narrows it.
 *
 * A PURE FUNCTION OF THE TENANT: it reseeds first. Alarm and incident ids come
 * from the seeded uuid source, so without this every replay continued the
 * stream and minted new ids for the same alarms - and the board, which merges
 * its snapshot with the live feed BY alarmId, showed a live alarm as a
 * stranger to the incident that paged it. The tab and the API computing the
 * same ids is the same fix: neither depends on what ran before.
 */
export function tenantScenarios(caller: Principal) {
  seedDemoWorld();
  return runScenarios(rulesPrincipal(caller));
}

/** The network view, scoped to the caller. */
export function boardSnapshot(caller: Principal, siteId?: string): BoardSnapshot {
  const { alarms, incidents, heldBack } = tenantScenarios(caller);

  // TWO STEPS, and both are needed. withinScope() is the BOUNDARY, derived
  // from the token; siteId is the caller's chosen VIEW. Applying only the
  // first meant a Dallas operator who asked for Phoenix got Dallas's devices
  // rendered under a Phoenix heading - not a leak, since scope had already
  // excluded Phoenix, but wrong in a way that would make someone distrust the
  // board the moment they noticed.
  const atSite = (x: { siteId: string }) => !siteId || x.siteId === siteId;
  // Alarms and incidents are filtered by scope as well as by view: the
  // scenarios ran tenant-wide, and an operator scoped to Dallas asking for no
  // particular site must not receive Phoenix's.
  const visibleSites = new Set(withinScope(caller, allDeviceStates(caller)).map((d) => d.siteId));
  const inScope = (x: { siteId: string }) => visibleSites.has(x.siteId) && atSite(x);

  return {
    devices: withinScope(caller, allDeviceStates(caller)).filter(atSite),
    sites: allSites(caller),
    alarms: alarms.filter(inScope),
    incidents: incidents.filter(inScope),
    heldBack: heldBack.filter(inScope),
  };
}

/**
 * The comms view, read from the store - or null when this caller has none:
 * their tenant runs no comms sources, or their scope is narrower than the
 * tenant. Null rather than an empty snapshot, so the board can tell "nothing
 * wrong" from "not yours to see".
 */
export async function commsSnapshot(caller: Principal): Promise<CommsSnapshot | null> {
  if (!commsVisibleTo(caller)) return null;
  // What the network rules decided, ONCE: the brief and the candidate causes
  // read the same decisions, so they cannot disagree about the network.
  const network = tenantScenarios(caller);
  const [workforce, incidents, alarms, health, resolved, phones, anomalies] = await Promise.all([
    commsWorkforce(caller),
    commsIncidents(caller),
    commsAlarms(caller),
    loadHealth(caller),
    commsResolvedIncidents(caller),
    commsPhones(caller),
    latestAnomalies(caller),
  ]);
  // Nothing polled yet: no view rather than a snapshot with holes in it.
  if (!workforce) return null;
  // The candidates BEFORE the brief, and handed to it: the board and the
  // brief show the same ones because they are the same call.
  const causes = await causesForIncidents(caller, incidents, network, new Date(now()).toISOString());
  // The network incidents the board's network view shows, so the brief and
  // the board cannot disagree about what is open either.
  const brief = await buildDailyBrief(caller, now(), { networkIncidents: network.incidents, causes });
  return {
    workforce,
    incidents,
    heldBack: alarms.filter((a) => !a.corroborated),
    health,
    resolved,
    phones,
    brief,
    anomalies: anomalies?.anomalies ?? [],
    causes,
  };
}

/** The newest this many. A page, not a report: the tallies say which window they cover. */
export const AUDIT_VIEW_LIMIT = 100;

export type AuditSnapshot = {
  /** Newest first. */
  entries: AuditEntry[];
  /** Over `entries` only - see summariseAudit. */
  summary: AuditSummary;
  limit: number;
  retentionDays: number;
};

/**
 * The audit view: what the assistant's tools were asked, by whom, and how it
 * went - or null for anyone but an admin. It names who asked what, which is
 * not an operator's business about their colleagues; null rather than a 403,
 * as for comms, so the board simply does not offer the view.
 *
 * Read from the STORE, so what it shows depends on who wrote there: over the
 * board API, the MCP server's rows in DynamoDB; in the tab, the tab
 * assistant's own demonstration rows. The board says which.
 */
export async function auditSnapshot(caller: Principal): Promise<AuditSnapshot | null> {
  if (!caller.roles.includes('admin')) return null;
  const entries = await recentAudit(caller, AUDIT_VIEW_LIMIT);
  return { entries, summary: summariseAudit(entries), limit: AUDIT_VIEW_LIMIT, retentionDays: AUDIT_RETENTION_DAYS };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export type BoardApiDeps = {
  /** Access token -> Principal, or throw. In Lambda: the RS256 verifier against the pool's JWKS. */
  verify: (token: string) => Promise<Principal>;
  /** Allowed browser origins, echoed in CORS headers on error responses the gateway does not decorate. */
};

export async function handleBoardApi(event: ApiGatewayEvent, deps: BoardApiDeps): Promise<ApiGatewayResult> {
  const route = event.requestContext.http.method + ' ' + event.rawPath;

  // Header names arrive lower-cased from an HTTP API; be exact about the scheme.
  const header = event.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  let caller: Principal;
  try {
    if (!token) throw new Error('no bearer token');
    caller = await deps.verify(token);
  } catch (err) {
    // The same answer for every failure. Which check failed is useful to an
    // attacker and to nobody else; it goes to the log.
    log.warn('board api: token rejected', { route, reason: err instanceof Error ? err.message : String(err) });
    return json(401, { message: 'Unauthorized' });
  }

  try {
    seedDemoWorld();
    switch (route) {
      case 'GET /board':
        return json(200, boardSnapshot(caller, event.queryStringParameters?.siteId || undefined));
      case 'GET /comms':
        return json(200, await commsSnapshot(caller));
      case 'GET /audit':
        return json(200, await auditSnapshot(caller));
      default:
        return json(404, { message: 'no route for ' + route });
    }
  } catch (err) {
    if (err instanceof OutOfScopeError) return json(403, { message: err.message });
    // Log the detail, return a generic message: stack traces and internal
    // identifiers in a response are an information-disclosure finding.
    log.error('board api: unhandled error', { route, error: err instanceof Error ? err.message : String(err) });
    return json(500, { message: 'internal error', requestId: event.requestContext.requestId });
  }
}

function json(statusCode: number, body: unknown): ApiGatewayResult {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      // Per-caller data: never let a shared cache or the browser's back button
      // serve one operator's board to the next person at the desk.
      'cache-control': 'no-store',
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}
