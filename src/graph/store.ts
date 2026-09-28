/**
 * The graph in the main table: an adjacency list, one partition per node.
 *
 *   PK TENANT#t#GRAPH#Facility#1120            SK META                          the node
 *   PK TENANT#t#GRAPH#Facility#1120            SK IN#LOCATED_AT#Device#dev-...  an edge, seen from its target
 *   PK TENANT#t#GRAPH#Device#dev-cor-hou01-01  SK OUT#LOCATED_AT#Facility#1120  the same edge, from its source
 *   PK TENANT#t#GRAPH                          SK NODE#Device#dev-cor-hou01-01  the index
 *
 * Every edge is written BOTH ways, so "what is in this building?" and "which
 * building is this box in?" are each ONE Query with begins_with on the sort
 * key. The questions asked of it are one to three hops from a known node;
 * that is what an adjacency list is good at and why this is not Neptune
 * (docs/12, Part 3: an always-on capacity charge for traversals nobody runs).
 *
 * Ids are URI-encoded inside keys - a Helix site name has spaces, and an id
 * with a `#` would otherwise split into two key segments. Readers never
 * parse keys: every item carries its raw refs.
 *
 * REBUILT, NOT EDITED. It is derived data, like everything in the table:
 * `buildGraph` recomputes it from the sources after a poll, and a rebuild is
 * idempotent (items are overwritten by key). Stale items - a device that was
 * decommissioned, an edge that no longer holds - are found through the index
 * rather than a Scan, and removed in an order that survives a crash anywhere:
 *
 *   1. write every item of the new build, index included
 *   2. delete what the new build did not write, partition by partition
 *   3. delete index entries for nodes that are gone - LAST, so a crash before
 *      it leaves the index still pointing at partitions step 2 must revisit.
 *
 * TENANT-WIDE ONLY. The graph spans sites and facilities, and a scoped view of
 * it needs a facility scope that does not exist yet; until it does, reads
 * require tenant scope, as comms reads do (CLAUDE.md).
 */
import type { Principal } from '../platform/types.ts';
import { now } from '../platform/clock.ts';
import { pk } from '../platform/tenancy.ts';
import { forEachByKey } from '../platform/concurrency.ts';
import { mainTable, type Item } from '../aws/dynamodb.ts';
import { requireTenantScope, commsWorkforce } from '../integrations/comms/store.ts';
import { commsConfigFor } from '../integrations/comms/config.ts';
import { allDevices, allSites, loadEstate } from '../geo/device-repository.ts';
import { deriveGraph } from './derive.ts';
import type { Graph, GraphNode, NodeRef, Relation } from './model.ts';

const seg = (s: string) => encodeURIComponent(s);
const indexPk = (p: Principal) => pk(p, 'GRAPH');
const nodePk = (p: Principal, r: NodeRef) => pk(p, 'GRAPH#' + r.type + '#' + seg(r.id));
const edgeSk = (dir: 'OUT' | 'IN', rel: Relation, other: NodeRef) => dir + '#' + rel + '#' + other.type + '#' + seg(other.id);

function itemsFor(p: Principal, graph: Graph, builtAt: string): Item[] {
  const items: Item[] = [];
  for (const n of graph.nodes) {
    items.push({ PK: nodePk(p, n), SK: 'META', entity: 'GraphNode', type: n.type, id: n.id, label: n.label, props: n.props, builtAt });
    items.push({ PK: indexPk(p), SK: 'NODE#' + n.type + '#' + seg(n.id), entity: 'GraphIndex', type: n.type, id: n.id, builtAt });
  }
  for (const e of graph.edges) {
    const body = { entity: 'GraphEdge', rel: e.rel, from: e.from, to: e.to, builtAt };
    items.push({ PK: nodePk(p, e.from), SK: edgeSk('OUT', e.rel, e.to), ...body });
    items.push({ PK: nodePk(p, e.to), SK: edgeSk('IN', e.rel, e.from), ...body });
  }
  return items;
}

export type GraphWrite = { nodes: number; edges: number; removed: number };

/** Persist a graph for the principal's tenant, replacing whatever was there. */
export async function writeGraph(principal: Principal, graph: Graph): Promise<GraphWrite> {
  requireTenantScope(principal);
  const items = itemsFor(principal, graph, new Date(now()).toISOString());
  const k = (i: { PK: string; SK: string }) => i.PK + '\u0000' + i.SK;
  const wanted = new Set(items.map(k));

  // 1. Write first - the INDEX before anything it points at. A batch that
  //    fails half-way must not leave a partition the index does not know:
  //    step 2 only visits indexed partitions, so that node could never be
  //    cleaned up. An index entry with nothing behind it is harmless.
  await mainTable.batchPut(items.filter((i) => i.entity === 'GraphIndex'));
  await mainTable.batchPut(items.filter((i) => i.entity !== 'GraphIndex'));

  // 2. Everything the index knows - the last build's nodes and this one's -
  //    and in each of their partitions, whatever this build did not write.
  const indexed = await mainTable.query({ pk: indexPk(principal) });
  const partitions = [...new Set(indexed.map((r) => nodePk(principal, { type: r.type as NodeRef['type'], id: String(r.id) })))];
  let removed = 0;
  await forEachByKey(partitions, (p) => p, async (partition) => {
    for (const row of await mainTable.query({ pk: partition })) {
      if (!wanted.has(k(row))) { await mainTable.delete(row.PK, row.SK); removed++; }
    }
  });

  // 3. The index, last.
  for (const row of indexed) {
    if (!wanted.has(k(row))) { await mainTable.delete(row.PK, row.SK); removed++; }
  }
  return { nodes: graph.nodes.length, edges: graph.edges.length, removed };
}

/**
 * Derive the tenant's graph from its sources and persist it. Run after a
 * poll (and by `pnpm seed:aws`). The people counts come from the stored
 * workforce SUMMARY - counts, never the roster, which is not stored at all.
 */
export async function buildGraph(principal: Principal): Promise<GraphWrite> {
  requireTenantScope(principal);
  loadEstate(principal.tenantId);
  const config = commsConfigFor(principal.tenantId);
  const workforce = config ? await commsWorkforce(principal) : undefined;
  const graph = deriveGraph({
    sites: allSites(principal),
    devices: allDevices(principal),
    config,
    peopleByFacility: workforce ? Object.fromEntries(workforce.byFacility.map((f) => [f.code, f.people])) : undefined,
  });
  return writeGraph(principal, graph);
}

// ---------------------------------------------------------------------------
// Reads - one GetItem or one Query each
// ---------------------------------------------------------------------------

/**
 * Has a graph been built for this tenant at all? One Query, one item. The
 * difference between "the graph is not there" and "this thing is not in the
 * graph" - which must not be reported alike.
 */
export async function graphBuilt(principal: Principal): Promise<boolean> {
  requireTenantScope(principal);
  return (await mainTable.query({ pk: indexPk(principal), limit: 1 })).length > 0;
}

export async function graphNode(principal: Principal, ref: NodeRef): Promise<GraphNode | undefined> {
  requireTenantScope(principal);
  const item = await mainTable.get(nodePk(principal, ref), 'META');
  if (!item) return undefined;
  return { type: item.type as NodeRef['type'], id: String(item.id), label: String(item.label), props: (item.props ?? {}) as GraphNode['props'] };
}

export type Neighbour = { rel: Relation; direction: 'out' | 'in'; node: NodeRef };

/**
 * A node's edges, both directions unless narrowed - one Query either way.
 * Sorted, so what a caller reports is stable.
 */
export async function neighbours(
  principal: Principal,
  ref: NodeRef,
  opts: { direction?: 'out' | 'in'; rel?: Relation } = {},
): Promise<Neighbour[]> {
  requireTenantScope(principal);
  const prefix = opts.direction ? (opts.direction === 'out' ? 'OUT#' : 'IN#') + (opts.rel ? opts.rel + '#' : '') : undefined;
  const rows = await mainTable.query({ pk: nodePk(principal, ref), ...(prefix ? { skBeginsWith: prefix } : {}) });
  return rows
    .filter((r) => r.entity === 'GraphEdge' && (!opts.rel || r.rel === opts.rel))
    .map((r): Neighbour => {
      const out = String(r.SK).startsWith('OUT#');
      return { rel: r.rel as Relation, direction: out ? 'out' : 'in', node: (out ? r.to : r.from) as NodeRef };
    })
    .sort((a, b) => (a.direction + a.rel + a.node.type + a.node.id).localeCompare(b.direction + b.rel + b.node.type + b.node.id));
}
