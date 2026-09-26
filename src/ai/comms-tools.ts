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
import { commsAlarms, commsIncidents, commsVisibleTo, commsWorkforce } from '../integrations/comms/store.ts';
import { COMMS_SOURCES } from '../integrations/comms/types.ts';
import { describeChange } from '../integrations/comms/helix-context.ts';
import { describeSource, loadHealth } from '../integrations/comms/health.ts';

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
        // Where, before the evidence: it is what decides who gets the call.
        for (const l of i.localisation ?? []) lines.push('  where: ' + l);
        // Helix context. CANDIDATES - the tool says so in every line, so a
        // model summarising it has the qualifier in front of it.
        if (i.context?.status === 'ok') {
          for (const c of i.context.changes) lines.push('  recent change: ' + describeChange(c));
          for (const t of i.context.tickets) {
            lines.push('  already in Helix: ' + t.id + ' "' + t.summary + '" (' + t.status + ', ' + (t.group ?? 'unassigned') + ')');
          }
          if (i.context.changes.length === 0) lines.push('  recent change: none on this subject in Helix');
        } else if (i.context) {
          lines.push('  helix: ' + i.context.note);
        }
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
      // Say so when placement is not final - a model that reports a facility
      // count as settled while the first directory sync is still running is
      // confidently wrong in a way nobody can see.
      if (w.directory.status === 'first-sync-in-progress' || w.directory.status === 'never-synced') {
        lines.push('  NOTE: the Entra directory sync has not finished; facility counts are incomplete.');
      } else if (w.directory.status === 'resyncing') {
        lines.push('  NOTE: the Entra directory is resyncing; facility counts use the previous copy.');
      }
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
  {
    spec: {
      name: 'integrationHealth',
      description:
        'Report whether each comms data feed (Entra directory, Teams, Genesys, Webex, ' +
        'Bandwidth, Helix) answered on the latest poll, since when a failing one has ' +
        'been failing, and any data-quality gaps with their fixes. Use this whenever ' +
        'data looks missing, stale or incomplete, or before concluding "nothing is ' +
        'wrong" - a quiet board can mean a feed is down.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    execute(_input, principal) {
      const h = loadHealth(principal);
      if (!h) return 'No comms poll has recorded integration health yet.';
      const lines = ['Integration health as of ' + h.asOf + ':'];
      for (const s of h.sources) lines.push('  ' + describeSource(s));
      const down = h.sources.filter((s) => s.status === 'down');
      if (down.length > 0) {
        // The inference a model most needs spelled out: absence of an
        // incident from a down source is not evidence of health.
        lines.push('  NOTE: ' + down.map((s) => s.source).join(', ') + ' did not answer; an absence of ' +
          'incidents from ' + (down.length === 1 ? 'it' : 'them') + ' means UNKNOWN, not healthy.');
      }
      if (h.dataQuality.length > 0) {
        lines.push('Data quality:');
        for (const q of h.dataQuality) lines.push('  ' + q.detail + ' -> ' + q.action);
      }
      return lines.join('\n');
    },
  },
];

/** Comms tool specs for this caller: empty unless the tenant runs comms and the scope is tenant-wide. */
export function commsToolsFor(principal: Principal): ToolSpec[] {
  return commsVisibleTo(principal) ? COMMS_TOOLS.map((t) => t.spec) : [];
}
