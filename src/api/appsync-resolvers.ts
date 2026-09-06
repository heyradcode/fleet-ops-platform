/**
 * ---------------------------------------------------------------------------
 * AppSync resolvers
 * ---------------------------------------------------------------------------
 * AppSync gives you three resolver styles. Choosing correctly is most of the
 * skill, and it is a very likely interview question:
 *
 *   1. UNIT resolver, JS runtime (APPSYNC_JS)
 *      A small request/response module that runs INSIDE AppSync - no Lambda,
 *      no cold start, no per-invocation charge. Use it for direct DynamoDB
 *      operations. It is a restricted runtime: no async/await, no network, no
 *      require(), 32KB of code. See `getSiteResolver` below.
 *
 *   2. PIPELINE resolver
 *      Several functions in sequence sharing a `ctx.stash`. Use it for
 *      authorise -> fetch -> transform, still without a Lambda.
 *
 *   3. LAMBDA data source
 *      Full Node runtime. Use it when you need to call Bedrock, hit Aurora,
 *      or orchestrate several services - i.e. the agent and the map layer.
 *
 * The rule of thumb: if a resolver only reads or writes DynamoDB, do NOT put a
 * Lambda behind it. Direct resolvers are faster, cheaper and cannot cold start.
 *
 * The functions in this file are the LAMBDA data source, implemented properly.
 * VTL and APPSYNC_JS examples for the direct-DynamoDB paths are in api/vtl/.
 */
import type { Principal } from '../platform/types.ts';
import {
  recentTelemetry, telemetryForDriver, telemetryBySeverity,
  openIncidents, getIncident, putIncident,
} from '../platform/repository.ts';
import { allDrivers, getDriver, driversWithinRadius } from '../geo/driver-repository.ts';
import { driversToFeatureCollection } from '../geo/geojson.ts';
import { nowIso } from '../platform/clock.ts';
import { askWithRag } from '../ai/bedrock-rag.ts';
import { runAgent } from '../ai/agent-core.ts';
import { TOOL_SPECS, READ_ONLY_TOOL_SPECS } from '../ai/tools.ts';
import { requireRole } from '../platform/tenancy.ts';
import { incidentId as newIncidentId } from '../platform/ids.ts';
import { bus } from '../aws/eventbridge.ts';
import { publishToSubscribers } from './subscriptions.ts';
import { b64urlEncode } from '../platform/crypto.ts';

/**
 * The AppSync Lambda event. `identity` is populated from the verified Cognito
 * token by AppSync itself - you never parse a JWT in a resolver.
 */
export type AppSyncEvent = {
  info: { fieldName: string; parentTypeName: 'Query' | 'Mutation' | 'Driver' | 'Incident' };
  arguments: Record<string, unknown>;
  /** The parent object, for nested field resolvers like Driver.telemetry. */
  source?: Record<string, unknown>;
  identity: {
    sub: string;
    claims: Record<string, unknown>;
    groups: string[] | null;
  };
};

/** AppSync -> our Principal. The token is already verified at this point. */
export function principalFrom(event: AppSyncEvent): Principal {
  const claims = event.identity.claims;
  return {
    sub: event.identity.sub,
    email: String(claims.email ?? ''),
    tenantId: String(claims['custom:tenantId'] ?? ''),
    roles: (event.identity.groups ?? ['viewer']) as Principal['roles'],
    // The district claim is stamped by the PreTokenGeneration trigger, so a
    // dispatcher cannot widen their own board by editing the request.
    scope: claims['custom:district']
      ? { kind: 'district', districtId: String(claims['custom:district']) }
      : { kind: 'tenant' },
    identityProvider: 'cognito',
  };
}

export async function handler(event: AppSyncEvent): Promise<unknown> {
  const principal = principalFrom(event);
  const key = event.info.parentTypeName + '.' + event.info.fieldName;
  const args = event.arguments;

  switch (key) {
    // ---- Query ----------------------------------------------------------
    case 'Query.drivers':
      return allDrivers(principal);

    case 'Query.driver':
      return getDriver(principal, String(args.driverId));

    case 'Query.telemetry': {
      const limit = Number(args.limit ?? 25);
      const items = args.severity
        ? telemetryBySeverity(principal, args.severity as never).slice(0, limit)
        : recentTelemetry(principal, limit);
      // The cursor is opaque to the client and encodes DynamoDB's
      // LastEvaluatedKey. Never leak the raw key - it exposes the key schema.
      const nextToken = items.length === limit
        ? b64urlEncode(JSON.stringify({ after: items[items.length - 1].observedAt }))
        : null;
      return { items, nextToken };
    }

    case 'Query.incidents':
      return openIncidents(principal, Number(args.limit ?? 25));

    case 'Query.incident':
      return getIncident(principal, String(args.incidentId));

    case 'Query.driversNear':
      return driversWithinRadius(principal, { lon: Number(args.lon), lat: Number(args.lat) }, Number(args.radiusKm));

    case 'Query.mapLayer': {
      const sites = allDrivers(principal);
      const bySite = new Map(sites.map((s) => [s.driverId, telemetryForDriver(principal, s.driverId)]));
      const fc = driversToFeatureCollection(sites, bySite);
      return { featureCollection: JSON.stringify(fc), bbox: fc.bbox };
    }

    case 'Query.askRunbooks': {
      const rag = await askWithRag(String(args.question), principal);
      return {
        answer: rag.answer,
        citations: rag.citations.map((c) => ({ source: c.source, snippet: c.snippet })),
        trace: [],
        stoppedBecause: 'end_turn',
      };
    }

    // ---- Nested field resolvers -----------------------------------------
    /**
     * Driver.telemetry. This is where N+1 lives: `drivers { telemetry { .. } }` calls
     * it once per driver. Fixes, in order of preference:
     *   1. Make it a BatchInvoke resolver - AppSync hands the Lambda an ARRAY
     *      of events (up to 2000) and you do one Query per partition.
     *   2. Cache it - AppSync per-resolver caching, keyed on $context.source.
     *   3. Denormalise the top few readings onto the Driver item at write time.
     */
    case 'Driver.telemetry': {
      const driverId = String(event.source?.driverId);
      const all = telemetryForDriver(principal, driverId);
      const filtered = args.severity ? all.filter((s) => s.severity === args.severity) : all;
      return filtered.slice(0, Number(args.limit ?? 20));
    }

    case 'Incident.drivers': {
      const ids = (event.source?.driverIds as string[]) ?? [];
      return ids.map((id) => getDriver(principal, id)).filter(Boolean);
    }

    case 'Incident.telemetry': {
      const ids = new Set((event.source?.telemetryIds as string[]) ?? []);
      return recentTelemetry(principal, 500).filter((s) => ids.has(s.telemetryId));
    }

    // ---- Mutation --------------------------------------------------------
    case 'Mutation.openIncident': {
      const input = args.input as {
        title: string; severity: 'info' | 'warning' | 'critical';
        districtId: string; driverIds: string[];
      };
      // Belt and braces: the @aws_auth directive already blocked viewers, but
      // defence in depth costs one line.
      requireRole(principal, 'admin', 'dispatcher');

      const incident = {
        tenantId: principal.tenantId,
        incidentId: newIncidentId(),
        title: input.title,
        severity: input.severity,
        status: 'open' as const,
        districtId: input.districtId,
        driverIds: input.driverIds,
        exceptionIds: [],
        openedAt: nowIso(),
      };
      putIncident(principal, incident);

      // In real AppSync you do NOT do this - returning from the mutation IS
      // the publish, because the subscription is declared against it. This
      // call exists so the local demo can show subscribers receiving it.
      publishToSubscribers('onIncidentOpened', incident);

      await bus.putEvents({
        source: 'meridian.api',
        detailType: 'IncidentOpened',
        detail: { tenantId: incident.tenantId, incidentId: incident.incidentId, severity: incident.severity },
      });
      return incident;
    }

    case 'Mutation.acknowledgeIncident': {
      requireRole(principal, 'admin', 'dispatcher');
      const existing = getIncident(principal, String(args.incidentId));
      if (!existing) throw new Error('incident not found');

      const updated = { ...existing, status: 'acknowledged' as const };
      putIncident(principal, updated);
      publishToSubscribers('onIncidentAcknowledged', updated);
      return updated;
    }

    case 'Mutation.askAgent': {
      // Viewers get the read-only tool set; operators get the full one. The
      // agent's authority is the CALLER's authority, never the Lambda's.
      const isOperator = principal.roles.some((r) => r === 'admin' || r === 'dispatcher');
      const result = await runAgent({
        question: String(args.question),
        principal,
        tools: isOperator ? TOOL_SPECS : READ_ONLY_TOOL_SPECS,
      });

      return {
        answer: result.answer,
        citations: result.evidence.slice(0, 3).map((e) => ({
          source: /SOURCE (\S+)/.exec(e)?.[1] ?? 'telemetry',
          snippet: e.replace(/\s+/g, ' ').slice(0, 140),
        })),
        trace: result.trace,
        stoppedBecause: result.stoppedBecause,
      };
    }

    default:
      throw new Error('no resolver for ' + key);
  }
}
