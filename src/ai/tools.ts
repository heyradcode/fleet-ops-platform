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
 *      read "site xyz-99 not found - valid ids are dal-01, aus-01, ..." and fix
 *      its own call. A thrown exception just kills the turn.
 *
 * Every executor takes the caller's `Principal`. The agent has no ambient
 * authority: it can only see what the human who asked could already see.
 */
import type { ToolSpec } from '../aws/bedrock.ts';
import type { Principal } from '../platform/types.ts';
import { signalsForSite, openIncidents, putIncident } from '../platform/repository.ts';
import { sitesWithinRadius, getSite, locationOf } from '../geo/site-repository.ts';
import { knowledgeBase } from './knowledge-base.ts';
import { incidentId } from '../platform/ids.ts';
import { canUseTool } from './guardrails.ts';

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
      name: 'querySignals',
      description:
        'Fetch recent normalised telemetry for one site across every connected ' +
        'system - network devices, contact centre queues and observability ' +
        'probes. Use this to find out what is actually happening at a site ' +
        'before explaining why.',
      input_schema: {
        type: 'object',
        properties: {
          siteId: { type: 'string', description: 'Site id such as dal-01, aus-01, den-01, chi-01, phx-01.' },
          hours: { type: 'number', description: 'How many hours back to look. 1-24.' },
        },
        required: ['siteId', 'hours'],
      },
    },
    execute(input, principal) {
      const siteId = String(input.siteId);
      const site = getSite(principal, siteId);
      if (!site) {
        // Error-as-data: tell the model how to correct itself.
        return 'ERROR: unknown siteId "' + siteId + '". Valid ids: dal-01, aus-01, den-01, chi-01, phx-01.';
      }

      const since = new Date(Date.now() - Number(input.hours ?? 6) * 3600_000).toISOString();
      const signals = signalsForSite(principal, siteId, since);
      if (signals.length === 0) return 'No signals for ' + siteId + ' in that window.';

      const lines = signals
        .filter((s) => s.severity !== 'ok')
        .map((s) => [s.severity.toUpperCase(), s.provider, s.kind, s.value + s.unit, 'at ' + s.observedAt].join(' | '));

      return [
        'Site ' + site.name + ' (' + siteId + '), ' + site.headcount + ' staff, region ' + site.region + '.',
        signals.length + ' signals, ' + lines.length + ' non-OK:',
        ...lines.slice(0, 12),
      ].join('\n');
    },
  },

  {
    spec: {
      name: 'findNearbySites',
      description:
        'Find sites within a radius of a given site, using a spatial query. ' +
        'Use this to work out whether a problem is local to one building or ' +
        'regional - a regional pattern usually means the carrier, not the site.',
      input_schema: {
        type: 'object',
        properties: {
          siteId: { type: 'string', description: 'The site at the centre of the search.' },
          radiusKm: { type: 'number', description: 'Search radius in kilometres, 1-2000.' },
        },
        required: ['siteId', 'radiusKm'],
      },
    },
    execute(input, principal) {
      const centre = locationOf(principal, String(input.siteId));
      if (!centre) return 'ERROR: unknown siteId "' + input.siteId + '".';

      const nearby = sitesWithinRadius(principal, centre, Number(input.radiusKm));
      if (nearby.length <= 1) {
        return 'No other sites within ' + input.radiusKm + 'km - this site is isolated, ' +
          'so a shared regional cause is unlikely.';
      }

      return nearby
        .map((s) => s.siteId + ' (' + s.name + ') ' + s.distanceKm + 'km, ' + s.headcount + ' staff')
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
        .map((i) => i.incidentId + ' [' + i.severity + '] ' + i.title + ' sites=' + i.siteIds.join(','))
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
          siteIds: { type: 'array', items: { type: 'string' }, description: 'Affected site ids.' },
        },
        required: ['title', 'severity', 'siteIds'],
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
        siteIds: (input.siteIds as string[]) ?? [],
        signalIds: [],
        openedAt: new Date().toISOString(),
      };
      putIncident(principal, incident);
      return 'Opened ' + incident.incidentId + ': ' + incident.title;
    },
  },
];

export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => t.spec);

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((t) => t.spec.name === name);
}

/** Read-only subset, for a "explain but do not act" agent profile. */
export const READ_ONLY_TOOL_SPECS: ToolSpec[] = TOOLS
  .filter((t) => t.spec.name !== 'openIncident')
  .map((t) => t.spec);

