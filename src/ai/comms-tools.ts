/**
 * ---------------------------------------------------------------------------
 * The agent's comms tools - read-only
 * ---------------------------------------------------------------------------
 * Two tools for the questions an agency's operations lead actually asks: "is
 * anything wrong with the phones, and why did / didn't it page?" and "how many
 * of our people are on which platform, where?".
 *
 * READ-ONLY, DELIBERATELY. There is no comms equivalent of openIncident or
 * suppressAlarm yet, because a comms incident has no owner to page - the
 * routing (which queue manager, which facility's IT) is a decision for the
 * customer, not something to invent in a tool.
 *
 * OFFERED PER TENANT. `commsToolsFor` returns these only to a tenant that runs
 * comms sources, and only to a tenant-wide principal (see store.ts on scope).
 * Offering them to everyone would have every network question start with a
 * pointless comms lookup - and a tool that always answers "not configured"
 * teaches a model to stop trusting the tool list.
 *
 * HELD-BACK ALARMS ARE RETURNED ALONGSIDE INCIDENTS. "Why did nobody get paged
 * about Houston?" is as common a question as "what is wrong in Houston?", and
 * the answer - one source, needs a second - is only available if the tool
 * hands over what was NOT promoted as well as what was.
 */
import type { ToolSpec } from '../aws/bedrock.ts';
import type { Principal } from '../platform/types.ts';
import type { Tool } from './tools.ts';
import { commsConfigFor } from '../integrations/comms/config.ts';
import { commsAlarms, commsIncidents, commsWorkforce } from '../integrations/comms/store.ts';
import { COMMS_SOURCES } from '../integrations/comms/types.ts';

export const COMMS_TOOLS: Tool[] = [
  {
    spec: {
      name: 'listCommsIncidents',
      description:
        'List current voice and contact-centre problems for this tenant: failing ' +
        'SIP trunks (SBCs), facilities with degraded Teams or Webex call quality, ' +
        'and overwhelmed Genesys queues - plus the alarms that were raised but ' +
        'HELD BACK from paging, with the reason. Use this for any question about ' +
        'phones, calls, call quality, queues, or why something did or did not page.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    execute(_input, principal) {
      // Worst first. The store returns them in key order, which is a hash; a
      // reader - model or human - should meet the critical one before the rest.
      const rank = { critical: 0, warning: 1, info: 2, ok: 3 } as const;
      const incidents = commsIncidents(principal)
        .sort((a, b) => rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title));
      const held = commsAlarms(principal).filter((a) => !a.corroborated)
        .sort((a, b) => rank[a.severity] - rank[b.severity] || a.subject.name.localeCompare(b.subject.name));
      if (incidents.length === 0 && held.length === 0) {
        return 'No comms incidents and no held-back comms alarms in the latest poll.';
      }
      const lines: string[] = [];
      for (const i of incidents) {
        lines.push('INCIDENT ' + i.incidentId + ' [' + i.severity + '] ' + i.title +
          ' - sources: ' + i.sources.join(' + '));
        for (const e of i.evidence) lines.push('  evidence: ' + e);
      }
      for (const a of held) {
        lines.push('HELD BACK [' + a.severity + '] ' + a.subject.name + ' ' + a.kind + ' - ' + a.heldBack);
        for (const e of a.evidence) lines.push('  evidence: ' + e);
      }
      // The rule behind the grouping, so the model does not "helpfully" join
      // a queue incident to a trunk incident on its own.
      lines.push('Note: incidents are grouped per subject. Nothing here establishes which trunk ' +
        'carries which queue\'s calls; do not claim one caused another.');
      return lines.join('\n');
    },
  },

  {
    spec: {
      name: 'queryWorkforce',
      description:
        'Count voice users by platform (Teams, Genesys, Webex), by agency and by ' +
        'facility (LC code), from the latest directory poll. Use this for "how many ' +
        'people / agents / phone users" questions, or to judge how many people a ' +
        'facility problem affects. Returns counts only, never names.',
      input_schema: {
        type: 'object',
        properties: {
          facility: { type: 'string', description: 'Optional facility code, four digits, e.g. 1120.' },
        },
        required: [],
      },
    },
    execute(input, principal) {
      const w = commsWorkforce(principal);
      if (!w) return 'No workforce poll has completed for this tenant yet.';

      const facility = input.facility === undefined ? undefined : String(input.facility);
      if (facility !== undefined) {
        const row = w.byFacility.find((f) => f.code === facility);
        if (!row) {
          return 'ERROR: unknown facility "' + facility + '". Known facilities: ' +
            w.byFacility.map((f) => f.code).join(', ') + '.';
        }
        return 'Active voice users at LC=' + facility + ' (as of ' + w.asOf + '): ' +
          COMMS_SOURCES.map((s) => s + ' ' + (row.counts[s] ?? 0)).join(', ') + '.';
      }

      const lines = ['Workforce as of ' + w.asOf + (w.truncated ? ' (INCOMPLETE: a source was truncated)' : '') + ':'];
      for (const s of COMMS_SOURCES) {
        const p = w.byPlatform[s];
        if (!p) continue;
        const agencies = Object.entries(p.byAgency).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + ' ' + v);
        const contractors = Object.values(p.contractorsByDomain).reduce((a, b) => a + b, 0);
        const unknown = Object.values(p.unknownByDomain).reduce((a, b) => a + b, 0);
        lines.push('  ' + s + ': ' + p.people + ' people - ' + agencies.join(', ') +
          (contractors ? ', contractors ' + contractors : '') + (unknown ? ', UNKNOWN domain ' + unknown : ''));
      }
      const unplaced = Object.entries(w.unplacedByReason).map(([k, v]) => k + ' ' + v).join(', ');
      if (unplaced) lines.push('  not placed at a facility: ' + unplaced);
      return lines.join('\n');
    },
  },
];

/** Comms tool specs for this caller: empty unless the tenant runs comms and the scope is tenant-wide. */
export function commsToolsFor(principal: Principal): ToolSpec[] {
  const config = commsConfigFor(principal.tenantId);
  if (!config || config.sources.length === 0) return [];
  if (principal.scope.kind !== 'tenant') return [];
  return COMMS_TOOLS.map((t) => t.spec);
}
