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
import {
  commsAlarms, commsIncidents, commsPhones, commsResolvedIncidents, commsVisibleTo, commsWorkforce,
  requireTenantScope,
} from '../integrations/comms/store.ts';
import { COMMS_SOURCES } from '../integrations/comms/types.ts';
import { describeChange } from '../integrations/comms/helix-context.ts';
import { describeSource, loadHealth } from '../integrations/comms/health.ts';
import { buildDailyBrief, renderBrief } from '../reporting/daily-brief.ts';
import { latestAnomalies } from '../integrations/comms/anomalies.ts';
import { now } from '../platform/clock.ts';

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
    async execute(_input, principal) {
      // Worst first. The store returns them in key order, which is a hash; a
      // reader - model or human - should meet the critical one before the rest.
      const rank = { critical: 0, warning: 1, info: 2, ok: 3 } as const;
      const incidents = (await commsIncidents(principal))
        .sort((a, b) => rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title));
      const held = (await commsAlarms(principal)).filter((a) => !a.corroborated)
        .sort((a, b) => rank[a.severity] - rank[b.severity] || a.subject.name.localeCompare(b.subject.name));
      if (incidents.length === 0 && held.length === 0) {
        return 'No comms incidents and no held-back comms alarms in the latest poll.';
      }
      const lines: string[] = [];
      for (const i of incidents) {
        lines.push('INCIDENT ' + i.incidentId + ' [' + i.severity + '] ' + i.title +
          ' - sources: ' + i.sources.join(' + '));
        lines.push('  open since ' + i.openedAt + ', last raised ' + i.lastSeenAt +
          (i.peakSeverity !== i.severity ? ', peaked ' + i.peakSeverity : '') +
          (i.reopenCount ? ', reopened ' + i.reopenCount + 'x (flapping)' : ''));
        if (i.lifecycleNote) lines.push('  status: ' + i.lifecycleNote);
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
      const resolved = await commsResolvedIncidents(principal, 5);
      for (const r of resolved) {
        lines.push('RESOLVED ' + r.incidentId + ' ' + r.title + ' - open ' + r.openedAt + ' to ' + r.resolvedAt);
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
    async execute(input, principal) {
      const w = await commsWorkforce(principal);
      if (!w) return 'No workforce poll has completed for this tenant yet.';

      const facility = input.facility === undefined ? undefined : String(input.facility);
      if (facility !== undefined) {
        const row = w.byFacility.find((f) => f.code === facility);
        if (!row) {
          return 'ERROR: unknown facility "' + facility + '". Known facilities: ' +
            w.byFacility.map((f) => f.code).join(', ') + '.';
        }
        const phonesHere = (await commsPhones(principal))?.byFacility.find((f) => f.code === facility)?.count;
        return 'Active voice users at LC=' + facility + ' (as of ' + w.asOf + '): ' +
          COMMS_SOURCES.map((s) => s + ' ' + (row.counts[s] ?? 0)).join(', ') + '.' +
          (phonesHere !== undefined ? ' Cisco desk phones there (Kurmi): ' + phonesHere + '.' : '');
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
      // Devices, not people - reported beside the workforce, never added to it.
      const phones = await commsPhones(principal);
      if (phones) {
        lines.push('Cisco desk phones (Kurmi, devices not people)' + (phones.truncated ? ' - INCOMPLETE' : '') + ': ' +
          phones.total + ' enabled - ' +
          Object.entries(phones.byAgency).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + ' ' + v).join(', ') +
          (Object.keys(phones.unknownAgencyCodes).length
            ? ', UNKNOWN agency codes ' + Object.entries(phones.unknownAgencyCodes).map(([k, v]) => k + ' ' + v).join(', ') : '') +
          (phones.blankAgency ? ', no agency ' + phones.blankAgency : '') + '; ' + phones.disabled + ' disabled not counted');
      }
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
    async execute(_input, principal) {
      const h = await loadHealth(principal);
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
  {
    spec: {
      name: 'dailyBrief',
      description:
        'Produce the executive operations brief: overall red/amber/green status, every open ' +
        'problem in plain language with its impact on people and calls, what resolved in the ' +
        'last 24 hours, what is being watched, and how complete the underlying data is. Use ' +
        'this for "how are we doing", "give me a summary", or anything written for leadership. ' +
        'Quote its figures; never compute new ones.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    async execute(_input, principal) {
      return renderBrief(await buildDailyBrief(principal, now()), 'text');
    },
  },
  {
    spec: {
      name: 'explainAnomalies',
      description:
        'List what is UNUSUAL right now for each trunk, facility and queue compared with its own ' +
        'history for this hour of the week - including things below every alarm threshold - each ' +
        'with its normal range. Use it for "is anything odd", "is this normal for a Tuesday", or to ' +
        'put an incident in context. Anomalies are early warnings and context, never alarms.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    async execute(_input, principal) {
      requireTenantScope(principal);
      const latest = await latestAnomalies(principal);
      if (!latest) return 'No comms poll has recorded anomalies yet.';
      if (latest.anomalies.length === 0) {
        return 'Nothing unusual as of ' + latest.asOf + ' - or not enough history yet: a bucket needs ' +
          'four weeks of the same hour before it gives a verdict.';
      }
      const open = new Set((await commsIncidents(principal)).map((i) => i.subject.kind + ':' + i.subject.id));
      const early = latest.anomalies.filter((a) => !open.has(a.subject.kind + ':' + a.subject.id));
      const context = latest.anomalies.filter((a) => open.has(a.subject.kind + ':' + a.subject.id));
      return [
        'As of ' + latest.asOf + ':',
        'EARLY WARNING (no incident open):',
        ...(early.length ? early.map((a) => '  ' + a.explanation) : ['  none']),
        'CONTEXT for open incidents:',
        ...(context.length ? context.map((a) => '  ' + a.explanation) : ['  none']),
        ...(latest.omitted ? [latest.omitted + ' less unusual ones were not stored - these are the most unusual.'] : []),
      ].join('\n');
    },
  },
];

/** Comms tool specs for this caller: empty unless the tenant runs comms and the scope is tenant-wide. */
export function commsToolsFor(principal: Principal): ToolSpec[] {
  return commsVisibleTo(principal) ? COMMS_TOOLS.map((t) => t.spec) : [];
}
