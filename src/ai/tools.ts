/**
 * ---------------------------------------------------------------------------
 * The agent's tools
 * ---------------------------------------------------------------------------
 * A tool is a JSON Schema plus a function. The schema is a PROMPT - it is the
 * only thing the model sees, and it is how the model decides whether to call
 * the tool and with what arguments. Three rules that decide whether an agent
 * works or flails:
 *
 *   1. Describe WHEN to use it, not just what it does. "Search operational
 *      runbooks" is weak. "Use this when the user asks how to fix or triage a
 *      problem" tells the model the trigger condition.
 *   2. Make bad calls impossible via the schema - enums, required fields,
 *      bounded numbers. A constraint in the schema beats a plea in the prompt.
 *   3. Return errors as data (`is_error: true`), not exceptions. The model can
 *      read "driver drv-9999 not found - valid ids are drv-1000, ..." and fix
 *      its own call. A thrown exception just kills the turn.
 *
 * Every executor takes the caller's `Principal`. The agent has no ambient
 * authority: it can only see what the human who asked could already see, and
 * it can only do what that human could already do.
 */
import type { ToolSpec } from '../aws/bedrock.ts';
import type { Principal } from '../platform/types.ts';
import { telemetryForDriver, openIncidents, putIncident } from '../platform/repository.ts';
import { availableDriversNear, getDriver, locationOf } from '../geo/driver-repository.ts';
import { knowledgeBase } from './knowledge-base.ts';
import { incidentId } from '../platform/ids.ts';
import { now, nowIso } from '../platform/clock.ts';
import { canUseTool } from './guardrails.ts';
import { HOS_THRESHOLD_MINUTES } from '../integrations/connector.ts';

export type ToolExecutor = (
  input: Record<string, unknown>,
  principal: Principal,
) => Promise<string> | string;

export type Tool = { spec: ToolSpec; execute: ToolExecutor };

export const TOOLS: Tool[] = [
  {
    spec: {
      name: 'searchRunbooks',
      description:
        'Search the operational runbook library for triage steps, resolution ' +
        'procedures and escalation thresholds. Use this whenever the user asks ' +
        'how to fix, triage, or escalate a problem, or why something is ' +
        'happening. Always call this before recommending an action, so the ' +
        'recommendation is grounded in a documented procedure.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The symptom or question, in natural language.' },
        },
        required: ['query'],
      },
    },
    async execute(input, principal) {
      const hits = await knowledgeBase.retrieve(String(input.query), {
        tenantId: principal.tenantId,
        topK: 2,
      });
      if (hits.length === 0) return 'No runbook matched. Do not invent a procedure; say so.';

      return hits
        .map((h) => 'SOURCE ' + h.source + ' (' + h.metadata.section + ', score ' +
          h.score.toFixed(3) + ')\n' + h.text)
        .join('\n\n---\n\n');
    },
  },

  {
    spec: {
      name: 'queryDriverTelemetry',
      description:
        'Fetch recent normalised telemetry for one driver across every ' +
        'connected system - GPS, hours-of-service and dashcam. Use this to ' +
        'find out what is actually happening to a driver before explaining why.',
      input_schema: {
        type: 'object',
        properties: {
          driverId: { type: 'string', description: 'Driver id such as drv-1000.' },
          hours: { type: 'number', description: 'How many hours back to look. 1-24.' },
        },
        required: ['driverId', 'hours'],
      },
    },
    execute(input, principal) {
      const driverId = String(input.driverId);
      const driver = getDriver(principal, driverId);
      if (!driver) {
        // Error-as-data: tell the model how to correct itself.
        return 'ERROR: unknown driverId "' + driverId + '". Valid ids: drv-1000, ' +
          'drv-1016, drv-1027, drv-1038, drv-1049.';
      }

      const since = new Date(now() - Number(input.hours ?? 6) * 3600_000).toISOString();
      const readings = telemetryForDriver(principal, driverId, since);
      if (readings.length === 0) return 'No telemetry for ' + driverId + ' in that window.';

      const lines = readings
        .filter((t) => t.severity !== 'ok')
        .map((t) => [
          t.severity.toUpperCase(), t.provider, t.kind,
          t.value + t.unit, 'at ' + t.observedAt,
        ].join(' | '));

      return [
        driver.name + ' (' + driverId + '), vehicle ' + driver.vehicleId +
          ', district ' + driver.districtId + ', status ' + driver.status +
          ', ' + driver.hosRemainingMinutes + ' minutes of drive time left.',
        readings.length + ' readings, ' + lines.length + ' non-OK:',
        ...lines.slice(0, 12),
      ].join('\n');
    },
  },

  {
    spec: {
      name: 'findNearbyAvailableDrivers',
      description:
        'Find drivers near a given driver who could take over their work, ' +
        'using a spatial query. Use this when the user asks what their options ' +
        'are for reassigning a load, or whether help is close by. Only returns ' +
        'drivers with enough legal hours remaining to actually accept work.',
      input_schema: {
        type: 'object',
        properties: {
          driverId: { type: 'string', description: 'The driver at the centre of the search.' },
          radiusKm: { type: 'number', description: 'Search radius in kilometres, 1-500.' },
        },
        required: ['driverId', 'radiusKm'],
      },
    },
    execute(input, principal) {
      const centre = locationOf(principal, String(input.driverId));
      if (!centre) return 'ERROR: unknown driverId "' + input.driverId + '".';

      const nearby = availableDriversNear(principal, centre, Number(input.radiusKm))
        .filter((d) => d.driverId !== input.driverId);

      if (nearby.length === 0) {
        return 'No available drivers within ' + input.radiusKm + 'km. Everyone in ' +
          'range is either off duty or short on hours, so reassignment is not an option.';
      }

      return nearby
        .map((d) => d.driverId + ' (' + d.name + ') ' + d.distanceKm + 'km, ' +
          d.status + ', ' + d.hosRemainingMinutes + ' min left')
        .join('\n');
    },
  },

  {
    spec: {
      name: 'listOpenIncidents',
      description:
        'List currently open incidents for this tenant. Use this to check ' +
        'whether the problem is already being worked before opening a duplicate.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    execute(_input, principal) {
      const incidents = openIncidents(principal);
      if (incidents.length === 0) return 'No open incidents.';
      return incidents
        .map((i) => i.incidentId + ' [' + i.severity + '] ' + i.title +
          ' drivers=' + i.driverIds.join(','))
        .join('\n');
    },
  },

  {
    spec: {
      name: 'openIncident',
      description:
        'Open a new incident. This pages a human, so use it only when the user ' +
        'explicitly asks to raise one, and only after checking for duplicates ' +
        'with listOpenIncidents.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative summary.' },
          severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
          districtId: { type: 'string', description: 'District the incident is in.' },
          driverIds: { type: 'array', items: { type: 'string' }, description: 'Affected driver ids.' },
        },
        required: ['title', 'severity', 'districtId', 'driverIds'],
      },
    },
    execute(input, principal) {
      // Authorisation belongs HERE, not in the prompt. A viewer cannot page
      // anyone, no matter how the model was talked into calling this.
      const verdict = canUseTool(principal, 'openIncident');
      if (!verdict.allowed) return 'ERROR: ' + verdict.reason;

      const incident = {
        tenantId: principal.tenantId,
        incidentId: incidentId(),
        title: String(input.title),
        severity: input.severity as 'info' | 'warning' | 'critical',
        status: 'open' as const,
        districtId: String(input.districtId),
        driverIds: (input.driverIds as string[]) ?? [],
        exceptionIds: [],
        openedAt: nowIso(),
      };
      putIncident(principal, incident);
      return 'Opened ' + incident.incidentId + ': ' + incident.title;
    },
  },

  {
    spec: {
      name: 'reassignDriver',
      description:
        'Reassign a load from one driver to another. This changes the dispatch ' +
        'plan and notifies both drivers, so use it only when the user explicitly ' +
        'asks to reassign, and only after confirming the replacement has enough ' +
        'legal hours with findNearbyAvailableDrivers.',
      input_schema: {
        type: 'object',
        properties: {
          fromDriverId: { type: 'string', description: 'Driver giving up the load.' },
          toDriverId: { type: 'string', description: 'Driver taking it on.' },
          reason: { type: 'string', description: 'Why, for the audit record.' },
        },
        required: ['fromDriverId', 'toDriverId', 'reason'],
      },
    },
    execute(input, principal) {
      // The write tool that proves the rule: the agent acts with the CALLER's
      // authority, never the platform's. A safety reviewer can read everything
      // here and still not be able to move a load.
      const verdict = canUseTool(principal, 'reassignDriver');
      if (!verdict.allowed) return 'ERROR: ' + verdict.reason;

      const to = getDriver(principal, String(input.toDriverId));
      if (!to) return 'ERROR: unknown toDriverId "' + input.toDriverId + '".';
      if (to.hosRemainingMinutes <= HOS_THRESHOLD_MINUTES.warning) {
        // Refusing here rather than in the prompt matters: dispatching a driver
        // with no legal hours left is a regulatory violation, and it must be
        // impossible regardless of how convincingly the model was asked.
        return 'ERROR: ' + to.driverId + ' has only ' + to.hosRemainingMinutes +
          ' minutes of drive time left and cannot accept a reassignment.';
      }

      // In production this starts the Step Functions reassignment saga:
      // validate -> check eligibility -> notify both -> update plan -> emit.
      return 'Reassignment queued: ' + input.fromDriverId + ' -> ' + input.toDriverId +
        ' (' + input.reason + ').';
    },
  },
];

export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => t.spec);

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((t) => t.spec.name === name);
}

/** Read-only subset, for an "explain but do not act" agent profile. */
export const READ_ONLY_TOOL_SPECS: ToolSpec[] = TOOLS
  .filter((t) => t.spec.name !== 'openIncident' && t.spec.name !== 'reassignDriver')
  .map((t) => t.spec);
