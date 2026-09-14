/**
 * ---------------------------------------------------------------------------
 * AppSync resolvers
 * ---------------------------------------------------------------------------
 * AppSync gives you three resolver styles. Choosing correctly is most of the
 * skill:
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
import type { Principal, Alarm } from '../platform/types.ts';

/** The subset of an Alarm that crosses the subscription wire. */
type DeviceAlarmPayload = Pick<
  Alarm, 'alarmId' | 'deviceId' | 'siteId' | 'kind' | 'severity' | 'planes' | 'raisedAt'
>;
import {
  recentObservations, observationsForDevice, observationsBySeverity,
  recentAlarms, openIncidents, getIncident, putIncident,
} from '../platform/repository.ts';
import {
  allDeviceStates, allSites, deviceState, uplinkChain, subtreeOf,
} from '../geo/device-repository.ts';
import { withinScope, scopeAllowsSite } from '../platform/tenancy.ts';
import { devicesToFeatureCollection } from '../geo/geojson.ts';
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
  info: { fieldName: string; parentTypeName: 'Query' | 'Mutation' | 'Device' | 'Incident' };
  arguments: Record<string, unknown>;
  /** The parent object, for nested field resolvers like Device.observations. */
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
    // The site claim is stamped by the PreTokenGeneration trigger, so a
    // operator cannot widen their own board by editing the request.
    scope: claims['custom:site']
      ? { kind: 'site', siteId: String(claims['custom:site']) }
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
    case 'Query.devices': {
      // SCOPE FIRST, filters second. `siteId` is a convenience for the
      // client; withinScope() is the boundary, derived from the token. A
      // operator who passes another site gets an empty list rather than
      // someone else's board.
      let estate = withinScope(principal, allDeviceStates(principal));
      if (args.siteId) estate = estate.filter((d) => d.siteId === args.siteId);
      if (args.status) estate = estate.filter((d) => d.status === args.status);
      return estate;
    }

    case 'Query.sites':
      return allSites(principal);

    case 'Query.alarms': {
      const all = recentAlarms(principal, Number(args.limit ?? 50));
      const scoped = all.filter((e) => scopeAllowsSite(principal, e.siteId));
      return args.siteId
        ? scoped.filter((e) => e.siteId === args.siteId)
        : scoped;
    }

    /**
     * The topology query, and the reason the map is not the whole story.
     *
     * A fleet platform answers "who is near this driver" with a spatial query,
     * because proximity is what makes another truck useful. Proximity means
     * almost nothing here - forty devices in one building share a coordinate,
     * and the device that matters when one fails is the one ABOVE it, which may
     * be in a different rack, floor or building entirely. So the equivalent
     * question is answered from the topology graph, not from geometry.
     */
    case 'Query.topology': {
      const deviceId = String(args.deviceId);
      if (!deviceState(principal, deviceId)) return null;
      return {
        deviceId,
        upstream: uplinkChain(principal, deviceId),
        downstream: subtreeOf(principal, deviceId),
      };
    }

    case 'Query.device': {
      const device = deviceState(principal, String(args.deviceId));
      // Inside the tenant but outside the caller's site is still a refusal, and
      // it must look identical to "no such device". Returning undefined here
      // instead of null would serialise as a missing field rather than an
      // explicit null, which GraphQL clients read differently.
      if (!device || !scopeAllowsSite(principal, device.siteId)) return null;
      return device;
    }

    case 'Query.observations': {
      const limit = Number(args.limit ?? 25);
      const items = args.severity
        ? observationsBySeverity(principal, args.severity as never).slice(0, limit)
        : recentObservations(principal, limit);
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

    case 'Query.devicesAtSite': {
      const siteId = String(args.siteId);
      // Inside the tenant but outside the caller's site is still a refusal.
      if (!scopeAllowsSite(principal, siteId)) return [];
      return allDeviceStates(principal).filter((d) => d.siteId === siteId);
    }

    case 'Query.mapLayer': {
      const estate = allDeviceStates(principal);
      const byDevice = new Map(estate.map((d) => [d.deviceId, observationsForDevice(principal, d.deviceId)]));
      const fc = devicesToFeatureCollection(estate, byDevice);
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
     * Device.observations. This is where N+1 lives: `devices { observations { .. } }` calls
     * it once per device. Fixes, in order of preference:
     *   1. Make it a BatchInvoke resolver - AppSync hands the Lambda an ARRAY
     *      of events (up to 2000) and you do one Query per partition.
     *   2. Cache it - AppSync per-resolver caching, keyed on $context.source.
     *   3. Denormalise the top few readings onto the Device item at write time.
     */
    case 'Device.observations': {
      const deviceId = String(event.source?.deviceId);
      const all = observationsForDevice(principal, deviceId);
      const filtered = args.severity ? all.filter((s) => s.severity === args.severity) : all;
      return filtered.slice(0, Number(args.limit ?? 20));
    }

    case 'Incident.devices': {
      const ids = (event.source?.deviceIds as string[]) ?? [];
      return ids.map((id) => deviceState(principal, id)).filter(Boolean);
    }

    case 'Incident.observations': {
      const ids = new Set((event.source?.observationIds as string[]) ?? []);
      return recentObservations(principal, 500).filter((s) => ids.has(s.observationId));
    }

    // ---- Mutation --------------------------------------------------------
    case 'Mutation.openIncident': {
      const input = args.input as {
        title: string; severity: 'info' | 'warning' | 'critical';
        siteId: string; deviceIds: string[];
      };
      // Belt and braces: the @aws_auth directive already blocked viewers, but
      // defence in depth costs one line.
      requireRole(principal, 'admin', 'operator');

      const incident = {
        tenantId: principal.tenantId,
        incidentId: newIncidentId(),
        title: input.title,
        severity: input.severity,
        status: 'open' as const,
        siteId: input.siteId,
        deviceIds: input.deviceIds,
        alarmIds: [],
        openedAt: nowIso(),
      };
      putIncident(principal, incident);

      // In real AppSync you do NOT do this - returning from the mutation IS
      // the publish, because the subscription is declared against it. This
      // call exists so the local demo can show subscribers receiving it.
      publishToSubscribers('onIncidentOpened', incident);

      await bus.putEvents({
        source: 'netpulse.api',
        detailType: 'IncidentOpened',
        detail: { tenantId: incident.tenantId, incidentId: incident.incidentId, severity: incident.severity },
      });
      return incident;
    }

    case 'Mutation.acknowledgeIncident': {
      requireRole(principal, 'admin', 'operator');
      const existing = getIncident(principal, String(args.incidentId));
      if (!existing) throw new Error('incident not found');

      const updated = { ...existing, status: 'acknowledged' as const };
      putIncident(principal, updated);
      publishToSubscribers('onIncidentAcknowledged', updated);
      return updated;
    }

    /**
     * Called by the ingest pipeline with IAM auth, purely to trigger the
     * subscription fan-out.
     *
     * This is the AppSync detail people get wrong: you CANNOT push to a
     * subscription by writing to DynamoDB. A subscription is declared against a
     * MUTATION, and the payload is that mutation's return value - so a backend
     * that wants to push has to call the mutation, usually with IAM.
     *
     * And note what has no equivalent here: observations. Pushing 11,000
     * readings/sec to every connected board would be useless to a human and
     * ruinous to pay for. Positions refresh on a poll; only alarms push.
     */
    case 'Mutation.publishAlarm': {
      const alarm = args.input as DeviceAlarmPayload;
      // The subscription filter matches on these top-level fields, so they have
      // to be in the returned object - a subscriber cannot receive a field the
      // mutation did not return, even if they asked for it.
      publishToSubscribers('onDeviceAlarm', alarm);
      return alarm;
    }

    case 'Mutation.suppressAlarm': {
      // The same authorisation the agent's suppressAlarm tool goes through.
      // There is no privileged path for the agent - it calls what an operator
      // calls, with the operator's own authority.
      requireRole(principal, 'admin', 'operator');
      const input = args.input as { deviceId: string; minutes: number; reason: string };
      const target = deviceState(principal, input.deviceId);
      if (!target) throw new Error('unknown device');

      const dependents = subtreeOf(principal, input.deviceId);
      if (dependents.length > 0) {
        // A structural refusal, not a preference. Suppressing a device others
        // depend on hides the ROOT CAUSE of everything beneath it, so the
        // cascade still pages but now names a symptom. Enforced here as well as
        // in the tool, because both are entry points to the same action.
        throw new Error(
          input.deviceId + ' has ' + dependents.length + ' devices depending on it; ' +
          'suppressing it would hide the root cause of any outage beneath it',
        );
      }
      throw new Error('suppression windows are not implemented in the offline demo');
    }

    case 'Mutation.askAgent': {
      // Viewers get the read-only tool set; operators get the full one. The
      // agent's authority is the CALLER's authority, never the Lambda's.
      const isOperator = principal.roles.some((r) => r === 'admin' || r === 'operator');
      const result = await runAgent({
        question: String(args.question),
        principal,
        tools: isOperator ? TOOL_SPECS : READ_ONLY_TOOL_SPECS,
      });

      return {
        answer: result.answer,
        citations: result.evidence.slice(0, 3).map((e) => ({
          source: /SOURCE (\S+)/.exec(e)?.[1] ?? 'observations',
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
