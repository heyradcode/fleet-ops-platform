/**
 * The graph, derived from the sources. A PURE function of its inputs - the
 * estate, the tenant's tables and a count per facility - so what it produces
 * is tested without a store, and rebuilding from the same inputs produces
 * byte-identical output (sorted, like everything reported here).
 *
 * SBC RUNS_ON Device comes from the tenant's `sbcSwitch` table - which
 * switch each SBC is plugged into, by hostname - and ONLY from it: a hostname
 * the estate does not have is no edge, never a guess. A guessed edge would
 * plant a candidate cause that is not there.
 *
 * Queue STAFFED_FROM Facility comes from the stored queue STAFFING - a
 * queue's Genesys members placed through the workforce join, as counts
 * (comms/staffing.ts). The edge carries how many agents; the queue node how
 * many members in all, placed or not, because a share of the placed is not a
 * share of the queue.
 *
 * What is NOT derived, and why:
 *   - Device CIs in Helix. Those arrive with each change and are joined at
 *     query time through the inventory aliases (itsm-tools.ts), as now.
 */
import type { CommsTenantConfig } from '../integrations/comms/types.ts';
import type { QueueStaffing } from '../integrations/comms/staffing.ts';
import type { Device, Site } from '../platform/types.ts';
import { refKey, type Graph, type GraphEdge, type GraphNode, type NodeRef } from './model.ts';

export type GraphSources = {
  sites: Site[];
  devices: Device[];
  /** Absent for a tenant with no comms sources: its graph is the topology alone. */
  config?: CommsTenantConfig;
  /** UNIQUE people per facility code, from the workforce split. Counts only. */
  peopleByFacility?: Record<string, number>;
  /** Per queue, members per building. Counts only. */
  queueStaffing?: QueueStaffing[];
};

export function deriveGraph(src: GraphSources): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const node = (n: GraphNode): NodeRef => {
    const ref = { type: n.type, id: n.id };
    const existing = nodes.get(refKey(ref));
    // First writer names it; later sightings only add facts.
    nodes.set(refKey(ref), existing ? { ...existing, props: { ...n.props, ...existing.props } } : n);
    return ref;
  };
  const edge = (from: NodeRef, rel: GraphEdge['rel'], to: NodeRef, props?: Record<string, number>) => {
    edges.set(refKey(from) + '>' + rel + '>' + refKey(to), { from, rel, to, ...(props ? { props } : {}) });
  };

  const facilityNames = src.config?.facilityNames ?? {};
  const facility = (code: string): NodeRef => node({
    type: 'Facility', id: code, label: facilityNames[code] ?? 'Facility ' + code,
    props: src.peopleByFacility?.[code] !== undefined ? { people: src.peopleByFacility[code] } : {},
  });
  for (const code of Object.keys(facilityNames)) facility(code);

  // --- The network, and the join -------------------------------------------
  const siteById = new Map(src.sites.map((s) => [s.siteId, s]));
  const deviceRef = (d: Device): NodeRef => node({
    type: 'Device', id: d.deviceId, label: d.name,
    props: { role: d.role, siteId: d.siteId, vendor: d.vendor },
  });
  for (const d of src.devices) {
    const ref = deviceRef(d);
    const code = siteById.get(d.siteId)?.facility;
    if (code) edge(ref, 'LOCATED_AT', facility(code));
    if (d.uplinkDeviceId) edge(ref, 'UPLINKS_TO', { type: 'Device', id: d.uplinkDeviceId });
  }

  // --- The comms side's tables ------------------------------------------------
  const config = src.config;
  if (config) {
    const sbc = (fqdn: string): NodeRef => node({ type: 'Sbc', id: fqdn, label: fqdn, props: {} });

    for (const [peer, fqdn] of Object.entries(config.bandwidth?.peerTrunk ?? {})) {
      const trunk = node({ type: 'Trunk', id: peer, label: 'Bandwidth peer ' + peer, props: { carrier: 'bandwidth' } });
      edge(trunk, 'TERMINATES_ON', sbc(fqdn));
    }
    for (const [ci, fqdn] of Object.entries(config.helix?.ciTrunk ?? {})) {
      edge(node({ type: 'HelixCi', id: ci, label: ci, props: {} }), 'IS', sbc(fqdn));
    }
    for (const [site, code] of Object.entries(config.helix?.siteFacility ?? {})) {
      edge(node({ type: 'HelixSite', id: site, label: site, props: {} }), 'IS', facility(code));
    }
    for (const [terminal, code] of Object.entries(config.starlink?.terminalFacility ?? {})) {
      edge(node({ type: 'SatelliteTerminal', id: terminal, label: 'Starlink ' + terminal.slice(-8), props: {} }), 'SERVES', facility(code));
    }
    // By HOSTNAME - what a CMDB or a network team calls the switch - joined
    // to the device that carries it. No such device, no edge.
    const byName = new Map(src.devices.map((d) => [d.name, d.deviceId]));
    for (const [fqdn, host] of Object.entries(config.sbcSwitch ?? {})) {
      const deviceId = byName.get(host);
      if (deviceId) edge(sbc(fqdn), 'RUNS_ON', { type: 'Device', id: deviceId });
    }
  }

  // --- The contact centre ----------------------------------------------------
  for (const q of src.queueStaffing ?? []) {
    const queue = node({
      type: 'Queue', id: q.queueId, label: q.queueName, props: { members: q.members, unplaced: q.unplaced },
    });
    for (const f of q.byFacility) edge(queue, 'STAFFED_FROM', facility(f.code), { agents: f.agents });
  }

  // An edge to a node nobody described (an uplink to a device outside the
  // estate) would be a dangling pointer every reader has to defend against.
  const kept = [...edges.values()].filter((e) => nodes.has(refKey(e.from)) && nodes.has(refKey(e.to)));

  return {
    nodes: [...nodes.values()].sort((a, b) => refKey(a).localeCompare(refKey(b))),
    edges: kept.sort((a, b) =>
      (refKey(a.from) + a.rel + refKey(a.to)).localeCompare(refKey(b.from) + b.rel + refKey(b.to))),
  };
}
