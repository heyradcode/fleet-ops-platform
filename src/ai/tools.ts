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
 *      read "device dev-9999 not found - valid ids are ..." and fix its own
 *      call. A thrown exception just kills the turn.
 *
 * Every executor takes the caller's `Principal`. The agent has no ambient
 * authority: it can only see what the human who asked could already see, and
 * it can only do what that human could already do.
 */
import type { ToolSpec } from '../aws/bedrock.ts';
import type { Principal } from '../platform/types.ts';
import { observationsForDevice, openIncidents, putIncident } from '../platform/repository.ts';
import {
  allDeviceStates, deviceState, subtreeOf, uplinkChain,
} from '../geo/device-repository.ts';
import { knowledgeBase } from './knowledge-base.ts';
import { incidentId } from '../platform/ids.ts';
import { now, nowIso } from '../platform/clock.ts';
import { canUseTool } from './guardrails.ts';
import { isEvent, isMetric } from '../platform/types.ts';
import { runSearch, splunkConfigured, type SearchName } from '../integrations/splunk/search.ts';
import { COMMS_TOOLS, commsToolsFor } from './comms-tools.ts';
import { ITSM_TOOLS, itsmToolsFor } from './itsm-tools.ts';

export type ToolExecutor = (
  input: Record<string, unknown>,
  principal: Principal,
) => Promise<string> | string;

export type Tool = { spec: ToolSpec; execute: ToolExecutor };

/** A few real ids, so an error message can teach the model to correct itself. */
function sampleDeviceIds(principal: Principal): string {
  return allDeviceStates(principal).slice(0, 5).map((d) => d.deviceId).join(', ');
}

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
      name: 'queryDeviceObservations',
      description:
        'Fetch recent normalised observations for one device across every feed ' +
        'and every observation plane - what the device said about itself, what ' +
        'its controller reported, and what our own probe found. Use this to ' +
        'establish what is actually happening before explaining why.',
      input_schema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Device id such as dev-cor-dal01-01.' },
          hours: { type: 'number', description: 'How many hours back to look. 1-24.' },
        },
        required: ['deviceId', 'hours'],
      },
    },
    execute(input, principal) {
      const deviceId = String(input.deviceId);
      const device = deviceState(principal, deviceId);
      if (!device) {
        // Error-as-data: tell the model how to correct itself.
        return 'ERROR: unknown deviceId "' + deviceId + '". Valid ids include: ' +
          sampleDeviceIds(principal) + '.';
      }

      const since = new Date(now() - Number(input.hours ?? 6) * 3600_000).toISOString();
      const observations = observationsForDevice(principal, deviceId, since);
      if (observations.length === 0) return 'No observations for ' + deviceId + ' in that window.';

      const lines = observations
        .filter((o) => o.severity !== 'ok')
        .map((o) => {
          const what = isMetric(o) ? o.kind + ' ' + o.value + o.unit
            : isEvent(o) ? o.kind + ' ' + o.state
              : 'flow';
          // The PLANE is included deliberately. "Three records, all device
          // plane" and "three records across three planes" are completely
          // different evidence, and the model cannot tell them apart without it.
          return [o.severity.toUpperCase(), o.plane, o.encoding, what, 'at ' + o.observedAt]
            .join(' | ');
        });

      return [
        device.name + ' (' + deviceId + '), ' + device.role + ' at ' + device.siteId +
          ', vendor ' + device.vendor + ', status ' + device.status +
          ', ' + device.interfacesDown + ' interfaces down, CPU ' +
          device.cpuUtilisation + '%.',
        observations.length + ' observations, ' + lines.length + ' non-OK:',
        ...lines.slice(0, 12),
      ].join('\n');
    },
  },

  {
    spec: {
      name: 'searchSplunk',
      description:
        'Search the customer\'s Splunk for context this platform does not hold - ' +
        'configuration changes, privileged logins, or any mention of a device ' +
        'across their other indexes. Use it when a device broke and you need to ' +
        'know whether somebody changed something first. Results are CONTEXT ' +
        'only: they never corroborate an alarm, because Splunk may well be ' +
        'reading the same vendor API this platform does.',
      input_schema: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            // An enum, not free text. The model picks from a catalogue; it
            // never composes SPL. See the note in integrations/splunk/search.ts
            // about what an injected pipe does inside a SIEM.
            enum: ['recent-config-changes', 'admin-logins', 'device-mentions'],
            description: 'Which catalogued search to run.',
          },
          deviceId: { type: 'string', description: 'The device to search around.' },
          hours: { type: 'number', description: 'How far back to look. 1-168.' },
        },
        required: ['search', 'deviceId', 'hours'],
      },
    },
    async execute(input, principal) {
      if (!splunkConfigured()) {
        // Error-as-data, and honest about which. "No results" and "not
        // connected" are completely different answers to an operator at 4am,
        // and collapsing them is how somebody concludes there were no config
        // changes when nobody ever asked.
        return 'Splunk is not configured for this deployment. Say so rather than ' +
          'concluding there were no changes.';
      }

      const deviceId = String(input.deviceId);
      const device = deviceState(principal, deviceId);
      if (!device) {
        return 'ERROR: unknown deviceId "' + deviceId + '". Valid ids include: ' +
          sampleDeviceIds(principal) + '.';
      }

      const result = await runSearch({
        name: input.search as SearchName,
        // The TENANT comes from the verified token, never from the model. An
        // agent that could choose its own tenant filter is a cross-tenant read
        // one prompt away.
        tenant: principal.tenantId,
        device: device.name,
        hours: Number(input.hours ?? 24),
      });

      if (result.rows.length === 0) {
        return 'No matching events in Splunk for ' + device.name + '. ' +
          'Ran: ' + result.spl;
      }

      return [
        result.rows.length + ' result(s) from Splunk for ' + device.name + ':',
        ...result.rows.map((r) => Object.entries(r).map(([k, v]) => k + '=' + v).join(' ')),
        // The SPL is returned deliberately. An operator who can see the query
        // can tell "nothing happened" from "you asked the wrong question",
        // which is the difference between trusting this answer and not.
        'Query: ' + result.spl,
      ].join('\n');
    },
  },

  {
    spec: {
      name: 'traceTopology',
      description:
        'Walk the network topology around a device: everything upstream of it ' +
        'toward the site core, and everything downstream that depends on it. ' +
        'Use this to decide whether a device is the CAUSE of an outage or ' +
        'merely a symptom of one further up, and to size the blast radius ' +
        'before recommending action.',
      input_schema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'The device at the centre of the trace.' },
        },
        required: ['deviceId'],
      },
    },
    execute(input, principal) {
      const deviceId = String(input.deviceId);
      const device = deviceState(principal, deviceId);
      if (!device) {
        return 'ERROR: unknown deviceId "' + deviceId + '". Valid ids include: ' +
          sampleDeviceIds(principal) + '.';
      }

      const upstream = uplinkChain(principal, deviceId);
      const downstream = subtreeOf(principal, deviceId);

      const upLine = upstream.length === 0
        ? deviceId + ' is a site root - nothing sits above it.'
        : 'Upstream, nearest first: ' + upstream.join(' -> ');

      const downLine = downstream.length === 0
        ? 'Nothing depends on ' + deviceId + '; a failure here affects only itself.'
        : downstream.length + ' devices depend on ' + deviceId + ': ' +
          downstream.slice(0, 12).join(', ') +
          (downstream.length > 12 ? ' (and ' + (downstream.length - 12) + ' more)' : '');

      return [
        device.name + ' is a ' + device.role + ' device at ' + device.siteId + '.',
        upLine,
        downLine,
        // The advice the topology exists to give.
        upstream.length > 0
          ? 'If devices upstream are also alarming, investigate those FIRST - ' +
            'this device is probably a symptom.'
          : 'A failure here is the root of its subtree.',
      ].join('\n');
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
          ' devices=' + i.deviceIds.length +
          (i.rootCauseDeviceId ? ' rootCause=' + i.rootCauseDeviceId : ''))
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
          siteId: { type: 'string', description: 'Site the incident is at.' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Affected device ids.' },
        },
        required: ['title', 'severity', 'siteId', 'deviceIds'],
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
        siteId: String(input.siteId),
        deviceIds: (input.deviceIds as string[]) ?? [],
        alarmIds: [],
        openedAt: nowIso(),
      };
      putIncident(principal, incident);
      return 'Opened ' + incident.incidentId + ': ' + incident.title;
    },
  },

  {
    spec: {
      name: 'suppressAlarm',
      description:
        'Suppress alarms for one device during planned maintenance, so a known ' +
        'outage does not page anyone. Use only when the user explicitly asks to ' +
        'suppress, and only after confirming with traceTopology that nothing ' +
        'important depends on the device.',
      input_schema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Device to suppress.' },
          minutes: { type: 'number', description: 'How long, 5-480.' },
          reason: { type: 'string', description: 'Why, for the audit record.' },
        },
        required: ['deviceId', 'minutes', 'reason'],
      },
    },
    execute(input, principal) {
      // The write tool that proves the rule: the agent acts with the CALLER's
      // authority, never the platform's. An engineer can read everything here
      // and still not be able to silence a page.
      const verdict = canUseTool(principal, 'suppressAlarm');
      if (!verdict.allowed) return 'ERROR: ' + verdict.reason;

      const deviceId = String(input.deviceId);
      const device = deviceState(principal, deviceId);
      if (!device) return 'ERROR: unknown deviceId "' + deviceId + '".';

      const dependents = subtreeOf(principal, deviceId);
      if (dependents.length > 0) {
        // Refusing here rather than in the prompt matters. Suppressing a device
        // that others depend on does not hide one alarm - it hides the ROOT
        // CAUSE of everything beneath it, so the cascade still pages but now
        // names a symptom. That must be impossible regardless of how
        // convincingly the model was asked.
        return 'ERROR: ' + deviceId + ' is a ' + device.role + ' device with ' +
          dependents.length + ' devices depending on it. Suppressing it would ' +
          'hide the root cause of any outage beneath it. Suppress the ' +
          'dependent devices individually, or take a maintenance window for ' +
          'the whole subtree.';
      }

      // In production this writes a suppression window to DynamoDB with a TTL,
      // which the publish step consults before putting anything on the bus.
      return 'Suppressed ' + deviceId + ' for ' + input.minutes + ' minutes (' +
        input.reason + ').';
    },
  },
];

export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => t.spec);

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((t) => t.spec.name === name)
    ?? COMMS_TOOLS.find((t) => t.spec.name === name)
    ?? ITSM_TOOLS.find((t) => t.spec.name === name);
}

/** Read-only subset, for an "explain but do not act" agent profile. */
export const READ_ONLY_TOOL_SPECS: ToolSpec[] = TOOLS
  .filter((t) => t.spec.name !== 'openIncident' && t.spec.name !== 'suppressAlarm')
  .map((t) => t.spec);

/**
 * The tools THIS caller is offered: the network set, plus the comms set when
 * their tenant runs comms sources and their scope admits it.
 *
 * TOOL_SPECS stays the network set on purpose. A model calls what it is
 * offered, and a network operator's agent reaching for a comms tool its tenant
 * does not have would spend a turn learning nothing.
 */
export function toolSpecsFor(principal: Principal, opts: { readOnly: boolean }): ToolSpec[] {
  return [...(opts.readOnly ? READ_ONLY_TOOL_SPECS : TOOL_SPECS), ...commsToolsFor(principal), ...itsmToolsFor(principal)];
}
