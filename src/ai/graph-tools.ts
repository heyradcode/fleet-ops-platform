/**
 * The agent's tools on the knowledge graph (docs/12, Part 3, phase 4).
 *
 *   whatServes        a facility's network, WAN link and names in other systems
 *   explainIncident   candidate causes for an open comms incident, with paths
 *   graphNeighbours   bounded exploration from one node - depth <= 2
 *
 * A FIXED CATALOGUE WITH TYPED ARGUMENTS, the SPL rule. The agent never
 * writes a graph query: a free-form query language handed to a model is an
 * injection surface, and the depth and node caps are what keep one question
 * from walking the whole estate. Arguments are forgiving where that is safe -
 * a facility by code OR by name, a node as `Type#id` OR as words - because a
 * model is told "Houston", not "1120", and a tool that only takes codes
 * teaches it to guess.
 *
 * READ-ONLY and TENANT-WIDE, like the graph (graph/store.ts). Offered with
 * the comms tools, to the same callers: a tenant with facilities, and a
 * tenant-wide principal. Behind the MCP server they are scoped and audited
 * like every other tool - nothing here knows or cares which route it is on.
 *
 * Candidate causes are CANDIDATES here as on the board. The tool text says
 * so, because a model repeats what a tool tells it with the confidence the
 * tool used.
 */
import type { ToolSpec } from '../aws/bedrock.ts';
import type { Principal } from '../platform/types.ts';
import type { Tool } from './tools.ts';
import { now } from '../platform/clock.ts';
import { commsConfigFor } from '../integrations/comms/config.ts';
import { commsIncidents, commsVisibleTo } from '../integrations/comms/store.ts';
import { tenantScenarios } from '../api/board-api.ts';
import { graphNode, neighbours, type Neighbour } from '../graph/store.ts';
import { candidateCauses, type CandidateCauses } from '../graph/correlate.ts';
import { refKey, type NodeRef, type NodeType, type Relation } from '../graph/model.ts';

const NODE_TYPES: NodeType[] = ['Facility', 'Device', 'Sbc', 'Trunk', 'SatelliteTerminal', 'HelixCi', 'HelixSite'];
const RELATIONS: Relation[] = ['LOCATED_AT', 'UPLINKS_TO', 'SERVES', 'TERMINATES_ON', 'IS'];
/** Depth 2 reaches "this building's devices, and what they uplink to". Deeper is a walk, not a question. */
export const MAX_DEPTH = 2;
/** A cap on what one call returns, whatever the depth. */
export const MAX_NODES = 40;

/**
 * A facility from what the caller wrote: its code, or a word of its name
 * ("Houston", "north austin"). Names come from the tenant's own tables,
 * never invented. The longest match wins, so "North Austin" is not Austin.
 */
export function resolveFacility(principal: Principal, text: string): string | undefined {
  const names = commsConfigFor(principal.tenantId)?.facilityNames ?? {};
  const code = /\b(\d{4})\b/.exec(text)?.[1];
  if (code && names[code]) return code;
  const lower = text.toLowerCase();
  const hits = Object.entries(names)
    .map(([c, name]) => ({ c, stem: name.toLowerCase().replace(/\b(regional|office|field|campus|central)\b/g, '').trim() }))
    .filter(({ stem }) => stem && lower.includes(stem))
    .sort((a, b) => b.stem.length - a.stem.length);
  return hits[0]?.c;
}

function knownFacilities(principal: Principal): string {
  // Sorted: facility codes are integer-like strings, which JavaScript
  // enumerates numerically FIRST - 1120 before 0412 - unless told otherwise.
  return Object.entries(commsConfigFor(principal.tenantId)?.facilityNames ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, n]) => c + ' ' + n).join(', ');
}

/** `Type#id`, or words: a facility, then a device id. */
function resolveNode(principal: Principal, text: string): NodeRef | undefined {
  const m = /^(\w+)#(.+)$/.exec(text.trim());
  if (m && (NODE_TYPES as string[]).includes(m[1])) return { type: m[1] as NodeType, id: m[2] };
  const facility = resolveFacility(principal, text);
  if (facility) return { type: 'Facility', id: facility };
  const device = /\b(dev-[a-z]{3}-[a-z0-9]+-\d{2})\b/i.exec(text)?.[1];
  return device ? { type: 'Device', id: device.toLowerCase() } : undefined;
}

const label = async (p: Principal, r: NodeRef) => {
  const n = await graphNode(p, r);
  return r.type + ' ' + (n ? n.label + (n.label !== r.id ? ' (' + r.id + ')' : '') : r.id);
};

function describeCauses(title: string, c: CandidateCauses): string {
  const head = 'INCIDENT ' + title;
  if (c.status === 'none') return head + '\n  looked, found nothing: nothing raised on ' + c.searched;
  if (c.status !== 'found') return head + '\n  no candidates: ' + c.reason;
  return head + '\n' + c.causes.map((x) =>
    '  CANDIDATE (not evidence) ' + x.device + ' (' + x.role + '): ' + x.what + ', ' + x.severity +
    (x.paged ? ', paged' : ', held back - one witness, it paged nobody') +
    ', ' + (x.minutesBefore === 0 ? 'same minute' : x.minutesBefore > 0 ? x.minutesBefore + ' min before' : -x.minutesBefore + ' min after') +
    '\n    path: ' + x.path).join('\n');
}

export const GRAPH_TOOLS: Tool[] = [
  {
    spec: {
      name: 'whatServes',
      description:
        'Describe what serves a facility (a building): the network devices located there, the ' +
        'satellite link that is its WAN if it has one, and the names other systems (Helix) use for ' +
        'it. Use this to connect a building\'s call quality or people to its network. Accepts the ' +
        'facility code (e.g. 1120) or its name (e.g. Houston).',
      input_schema: {
        type: 'object',
        properties: { facility: { type: 'string', description: 'Facility code (LC number) or name.' } },
        required: ['facility'],
      },
    },
    async execute(input, principal) {
      const code = resolveFacility(principal, String(input.facility ?? ''));
      if (!code) return 'ERROR: no facility matches "' + String(input.facility) + '". Known facilities: ' + knownFacilities(principal) + '.';
      const ref: NodeRef = { type: 'Facility', id: code };
      const facility = await graphNode(principal, ref);
      if (!facility) return 'The knowledge graph has no facility ' + code + ' - it has not been built for this tenant. Say so; do not guess.';
      const around = await neighbours(principal, ref, { direction: 'in' });
      const devices = await Promise.all(around.filter((n) => n.rel === 'LOCATED_AT').map(async (n) => {
        const d = await graphNode(principal, n.node);
        return (d?.label ?? n.node.id) + ' (' + String(d?.props.role ?? 'device') + ', ' + n.node.id + ')';
      }));
      const wan = around.filter((n) => n.rel === 'SERVES').map((n) => n.node.type + ' ' + n.node.id);
      const names = around.filter((n) => n.rel === 'IS').map((n) => n.node.type + ' "' + n.node.id + '"');
      return [
        'FACILITY ' + code + ' ' + facility.label + (facility.props.people !== undefined ? ' - ' + String(facility.props.people) + ' people (a count, never names)' : ''),
        'network: ' + (devices.length ? devices.length + ' devices: ' + devices.join('; ') : 'no network devices recorded here'),
        'satellite WAN: ' + (wan.join('; ') || 'none recorded'),
        'known elsewhere as: ' + (names.join('; ') || 'nothing mapped'),
        'SBCs: no source maps an SBC to a building yet, so none are listed - not "none exist".',
      ].join('\n');
    },
  },

  {
    spec: {
      name: 'explainIncident',
      description:
        'Candidate causes for an open voice or contact-centre incident, from the knowledge graph: ' +
        'what the network rules raised in the same building around the time it opened, with the ' +
        'path that links them. CANDIDATES, not evidence - say so when you use them. Give an ' +
        'incidentId from listCommsIncidents, or none to explain every open incident.',
      input_schema: {
        type: 'object',
        properties: { incidentId: { type: 'string', description: 'A comms incident id; omit for all open ones.' } },
        required: [],
      },
    },
    async execute(input, principal) {
      const open = await commsIncidents(principal);
      if (open.length === 0) return 'No open voice or contact-centre incidents.';
      const wanted = typeof input.incidentId === 'string' && input.incidentId.trim() ? input.incidentId.trim() : undefined;
      const chosen = wanted ? open.filter((i) => i.incidentId === wanted) : open;
      if (chosen.length === 0) {
        return 'ERROR: no open comms incident "' + String(wanted) + '". Open ones: ' + open.map((i) => i.incidentId).join(', ') + '.';
      }
      // What the network rules decided - the same function the board serves.
      const network = tenantScenarios(principal);
      const at = new Date(now()).toISOString();
      const described = await Promise.all(chosen.map(async (i) => describeCauses(i.title, await candidateCauses(principal, i, network, at))));
      return described.join('\n\n');
    },
  },

  {
    spec: {
      name: 'graphNeighbours',
      description:
        'Explore the knowledge graph from one node, at most ' + String(MAX_DEPTH) + ' hops and ' + String(MAX_NODES) +
        ' nodes. Node as Type#id (types: ' + NODE_TYPES.join(', ') + '; e.g. Facility#1120, ' +
        'Device#dev-wan-hou01-02), or a facility name. Optional relation filter: ' + RELATIONS.join(', ') + '.',
      input_schema: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Type#id, or a facility name.' },
          relation: { type: 'string', enum: RELATIONS },
          depth: { type: 'number', description: '1 or 2.' },
        },
        required: ['node'],
      },
    },
    async execute(input, principal) {
      const start = resolveNode(principal, String(input.node ?? ''));
      if (!start) return 'ERROR: cannot read a node from "' + String(input.node) + '". Use Type#id, e.g. Facility#1120 or Device#dev-wan-hou01-02.';
      if (!(await graphNode(principal, start))) return 'The knowledge graph has no ' + refKey(start) + '.';
      const relation = (RELATIONS as string[]).includes(String(input.relation)) ? input.relation as Relation : undefined;
      const depth = Math.min(MAX_DEPTH, Math.max(1, Math.floor(Number(input.depth) || 1)));

      // Breadth-first, capped. A seen-set, because the graph has both
      // directions of every edge and would otherwise walk straight back.
      // Every line past the first hop NAMES the node it hangs off: indented
      // under whatever printed last, a model reads the wrong tree.
      const labels = new Map<string, string>();
      const named = async (r: NodeRef) => {
        const k = refKey(r);
        if (!labels.has(k)) labels.set(k, await label(principal, r));
        return labels.get(k)!;
      };
      const seen = new Set([refKey(start)]);
      const lines: string[] = [];
      let frontier: NodeRef[] = [start];
      let truncated = false;
      for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
        const next: NodeRef[] = [];
        for (const from of frontier) {
          const edges: Neighbour[] = await neighbours(principal, from, relation ? { rel: relation } : {});
          for (const e of edges) {
            if (seen.has(refKey(e.node))) continue;
            if (seen.size > MAX_NODES) { truncated = true; break; }
            seen.add(refKey(e.node));
            next.push(e.node);
            const arrow = e.direction === 'out' ? ' -> ' + e.rel + ' -> ' : ' <- ' + e.rel + ' <- ';
            lines.push('  hop ' + String(hop) + ': ' + (hop === 1 ? 'this' : await named(from)) + arrow + (await named(e.node)));
          }
        }
        frontier = next;
      }
      return [await named(start), ...lines,
        truncated ? '(stopped at ' + String(MAX_NODES) + ' nodes - narrow it with a relation, or start nearer)' : ''].filter(Boolean).join('\n');
    },
  },
];

/** Offered with the comms tools, to the same callers: facilities exist, and the caller is tenant-wide. */
export function graphToolsFor(principal: Principal): ToolSpec[] {
  return commsVisibleTo(principal) ? GRAPH_TOOLS.map((t) => t.spec) : [];
}
