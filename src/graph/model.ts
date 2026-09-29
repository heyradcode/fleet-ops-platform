/**
 * ---------------------------------------------------------------------------
 * The knowledge graph: what serves what, across the network and comms domains
 * ---------------------------------------------------------------------------
 * The one question no single source answers - "Houston's call quality is
 * degraded; is it the building's network, its WAN link, the SBC, the
 * carrier?" - needs the domains JOINED. Each already reasons well inside
 * itself; this is the join (docs/12, Part 3).
 *
 * STRUCTURE ONLY. Nodes are things that exist (a facility, a device, an SBC)
 * and edges are how they serve each other. Incidents, alarms and changes are
 * NOT copied in: they stay in their own stores, and whoever walks the graph
 * joins them at query time. A second copy of every incident, kept in step
 * with the first, is a consistency bug waiting for its day.
 *
 * NO PEOPLE. There is no Person node type, so none can be written - the
 * workforce roster is never persisted (CLAUDE.md), and a graph of who sits
 * where would be that roster by another name. People appear only as a COUNT
 * on a facility.
 */

export type NodeType = 'Facility' | 'Device' | 'Sbc' | 'Trunk' | 'SatelliteTerminal' | 'HelixCi' | 'HelixSite' | 'Queue';

/**
 * Relations, each read FROM -> TO:
 *   Device LOCATED_AT Facility          the building a box is in - the join
 *   Device UPLINKS_TO Device            the topology tree, towards the core
 *   SatelliteTerminal SERVES Facility   a remote building's satellite WAN
 *   Trunk TERMINATES_ON Sbc             a carrier peer's end of an SBC
 *   Sbc RUNS_ON Device                  the switch an SBC is plugged into
 *   Queue STAFFED_FROM Facility         the buildings a queue's agents sit in
 *                                       (props.agents: how many - a COUNT)
 *   HelixCi IS Sbc | HelixSite IS Facility   Helix's names for our things
 */
export type Relation = 'LOCATED_AT' | 'UPLINKS_TO' | 'SERVES' | 'TERMINATES_ON' | 'RUNS_ON' | 'STAFFED_FROM' | 'IS';

export type NodeRef = { type: NodeType; id: string };

export type GraphNode = NodeRef & {
  label: string;
  /** Small, flat, non-personal facts. Counts, never names of people. */
  props: Record<string, string | number>;
};

/**
 * `props`: numbers about the RELATION, where one node cannot hold them - how
 * many of a queue's agents sit in THIS building belongs to neither the queue
 * nor the building. Counts only, like node props.
 */
export type GraphEdge = { from: NodeRef; rel: Relation; to: NodeRef; props?: Record<string, number> };

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

export const refKey = (r: NodeRef): string => r.type + '#' + r.id;
export const sameRef = (a: NodeRef, b: NodeRef): boolean => a.type === b.type && a.id === b.id;
