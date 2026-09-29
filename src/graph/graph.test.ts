/**
 * The knowledge graph: derived from the sources, stored both ways, rebuilt
 * cleanly - and never a roster.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { Principal } from '../platform/types.ts';
import { setRandom, seededRandom } from '../platform/random.ts';
import { setClock, fixedClock } from '../platform/clock.ts';
import { generateEstate } from '../data/estate.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from '../integrations/comms/config.ts';
import { OutOfScopeError } from '../platform/tenancy.ts';
import { mainTable } from '../aws/dynamodb.ts';
import { deriveGraph } from './derive.ts';
import { buildGraph, graphNode, neighbours, writeGraph } from './store.ts';
import type { Graph } from './model.ts';

const who = (tenantId: string, roles: Principal['roles'], scope: Principal['scope']): Principal =>
  ({ sub: 'g-' + tenantId, email: 'g@x', tenantId, roles, scope, identityProvider: 'cognito' });
const HHS = who(HHS_DEMO_TENANT, ['admin'], { kind: 'tenant' });
const HOUSTON_OPERATOR = who(HHS_DEMO_TENANT, ['operator'], { kind: 'site', siteId: 'hou-01' });
const OTHER = who('graph-other-tenant', ['admin'], { kind: 'tenant' });

beforeEach(() => { setRandom(seededRandom()); setClock(fixedClock()); });

function hhsGraph(people?: Record<string, number>): Graph {
  const estate = generateEstate(HHS_DEMO_TENANT);
  return deriveGraph({ sites: estate.sites, devices: estate.devices, config: COMMS_CONFIG[HHS_DEMO_TENANT], peopleByFacility: people });
}

test('every HHS device is LOCATED_AT its building\'s facility, and the tree is the estate\'s', () => {
  const estate = generateEstate(HHS_DEMO_TENANT);
  const g = hhsGraph();
  const located = g.edges.filter((e) => e.rel === 'LOCATED_AT');
  const inBuildings = estate.devices.filter((d) => d.siteId !== 'adc-01');
  assert.equal(located.length, inBuildings.length, 'every device in a facility, once');
  assert.ok(!located.some((e) => e.from.id.includes('adc01')), 'the data centre is not a facility, so nothing there is LOCATED_AT one');
  const houston = located.filter((e) => e.to.id === '1120').map((e) => e.from.id);
  assert.deepEqual(houston.sort(), estate.devices.filter((d) => d.siteId === 'hou-01').map((d) => d.deviceId).sort());
  const uplinks = g.edges.filter((e) => e.rel === 'UPLINKS_TO');
  assert.equal(uplinks.length, estate.devices.filter((d) => d.uplinkDeviceId).length);
});

test('the comms tables become edges: satellite WAN, trunks to SBCs, Helix names for our things', () => {
  const g = hhsGraph();
  const has = (from: string, rel: string, to: string) =>
    g.edges.some((e) => e.from.type + '#' + e.from.id === from && e.rel === rel && e.to.type + '#' + e.to.id === to);
  assert.ok(has('SatelliteTerminal#ut01000000-00000000-00d4e5f6', 'SERVES', 'Facility#3308'), 'Lubbock\'s WAN');
  assert.ok(has('Trunk#540101', 'TERMINATES_ON', 'Sbc#sbc1.voice.hhs.texas.example'));
  assert.ok(has('HelixCi#SBC2-TEAMS-DR', 'IS', 'Sbc#sbc2.voice.hhs.texas.example'));
  assert.ok(has('HelixSite#Houston Regional Office', 'IS', 'Facility#1120'));
  // Which switch each SBC is plugged into, from the tenant's table.
  assert.ok(has('Sbc#sbc1.voice.hhs.texas.example', 'RUNS_ON', 'Device#dev-acc-adc01-04'));
  assert.ok(has('Sbc#sbc2.voice.hhs.texas.example', 'RUNS_ON', 'Device#dev-acc-adc01-05'));
  // The tables' deliberate absences stay absent: no invented edges.
  assert.ok(!g.nodes.some((n) => n.id === '540103'), 'the legacy PBX peer has no SBC to terminate on');
  assert.ok(!g.nodes.some((n) => n.id === 'ut01000000-00000000-00ffee11'), 'the mobile van serves no facility');
  assert.ok(!g.edges.some((e) => e.rel === 'UPLINKS_TO' && e.to.type !== 'Device'));
});

test('RUNS_ON only from the table, only to a switch the estate has: a hostname it lacks is no edge, never a guess', () => {
  const estate = generateEstate(HHS_DEMO_TENANT);
  const config = COMMS_CONFIG[HHS_DEMO_TENANT];
  const g = deriveGraph({
    sites: estate.sites, devices: estate.devices,
    config: { ...config, sbcSwitch: { 'sbc1.voice.hhs.texas.example': 'acc-nowhere-99' } },
  });
  assert.ok(!g.edges.some((e) => e.rel === 'RUNS_ON'));
  const none = deriveGraph({ sites: estate.sites, devices: estate.devices, config: { ...config, sbcSwitch: undefined } });
  assert.ok(!none.edges.some((e) => e.rel === 'RUNS_ON'), 'no table, no edges');
});

test('a queue is STAFFED_FROM buildings: the count on the edge, every member - placed or not - on the node', () => {
  const estate = generateEstate(HHS_DEMO_TENANT);
  const g = deriveGraph({
    sites: estate.sites, devices: estate.devices, config: COMMS_CONFIG[HHS_DEMO_TENANT],
    queueStaffing: [{ queueId: 'q1', queueName: 'Eligibility - English', members: 50, byFacility: [{ code: '1120', agents: 12 }], unplaced: 27, truncated: false }],
  });
  assert.deepEqual(g.nodes.find((n) => n.type === 'Queue'),
    { type: 'Queue', id: 'q1', label: 'Eligibility - English', props: { members: 50, unplaced: 27 } });
  assert.deepEqual(g.edges.find((e) => e.rel === 'STAFFED_FROM'),
    { from: { type: 'Queue', id: 'q1' }, rel: 'STAFFED_FROM', to: { type: 'Facility', id: '1120' }, props: { agents: 12 } });
});

test('NO PEOPLE: no person node can exist, and a facility carries a count, never a name', () => {
  const g = hhsGraph({ '1120': 212 });
  assert.equal(g.nodes.find((n) => n.type === 'Facility' && n.id === '1120')?.props.people, 212);
  const everything = JSON.stringify(g);
  assert.ok(!everything.includes('@'), 'no email address anywhere in the graph');
  assert.deepEqual([...new Set(g.nodes.map((n) => n.type))].sort(),
    ['Device', 'Facility', 'HelixCi', 'HelixSite', 'SatelliteTerminal', 'Sbc', 'Trunk']);
});

test('the same sources give the same graph, byte for byte', () => {
  assert.equal(JSON.stringify(hhsGraph()), JSON.stringify(hhsGraph()));
});

test('stored both ways: "what is in this building" and "which building is this box in" are one Query each', async () => {
  await writeGraph(HHS, hhsGraph());
  const inHouston = await neighbours(HHS, { type: 'Facility', id: '1120' }, { direction: 'in', rel: 'LOCATED_AT' });
  assert.ok(inHouston.length > 0 && inHouston.every((n) => n.node.type === 'Device'));
  const where = await neighbours(HHS, inHouston[0].node, { direction: 'out', rel: 'LOCATED_AT' });
  assert.deepEqual(where.map((n) => n.node), [{ type: 'Facility', id: '1120' }]);
  assert.equal((await graphNode(HHS, { type: 'Facility', id: '1120' }))?.label, 'Houston Regional');
  // A Helix site name has spaces; ids are encoded in keys and come back raw.
  assert.deepEqual((await neighbours(HHS, { type: 'HelixSite', id: 'Houston Regional Office' })).map((n) => n.node.id), ['1120']);
});

test('a rebuild is idempotent, and what the sources dropped is gone - node, both edge ends, index', async () => {
  const full = hhsGraph();
  await writeGraph(HHS, full);
  const again = await writeGraph(HHS, full);
  assert.equal(again.removed, 0, 'the same graph twice removes nothing');

  // Decommission one Houston access point.
  const gone = full.nodes.find((n) => n.type === 'Device' && n.id.startsWith('dev-wir-hou01'))!;
  const smaller: Graph = {
    nodes: full.nodes.filter((n) => n !== gone),
    edges: full.edges.filter((e) => e.from.id !== gone.id && e.to.id !== gone.id),
  };
  const result = await writeGraph(HHS, smaller);
  assert.ok(result.removed >= 4, 'META, index, and at least one edge seen from each end');
  assert.equal(await graphNode(HHS, gone), undefined);
  assert.equal((await mainTable.query({ pk: 'TENANT#hhs-demo#GRAPH#Device#' + encodeURIComponent(gone.id) })).length, 0);
  const inHouston = await neighbours(HHS, { type: 'Facility', id: '1120' }, { direction: 'in', rel: 'LOCATED_AT' });
  assert.ok(!inHouston.some((n) => n.node.id === gone.id), 'the facility\'s side of the edge went too');
});

test('buildGraph wires the real sources; reads are tenant-wide only, and tenants never mix', async () => {
  const built = await buildGraph(HHS);
  assert.ok(built.nodes > 60 && built.edges > 60);
  await assert.rejects(neighbours(HOUSTON_OPERATOR, { type: 'Facility', id: '1120' }), OutOfScopeError);
  assert.deepEqual(await neighbours(OTHER, { type: 'Facility', id: '1120' }), [], 'another tenant\'s key space is empty');
});

test('a rebuild that fails half-way leaves nothing the next rebuild cannot clean - the index is written first', async () => {
  const { DynamoTable, setTableStore, resetTableStore } = await import('../aws/dynamodb.ts');
  const inner = new DynamoTable('graph-crash');
  let failNodes = false;
  setTableStore({
    name: inner.name,
    put: (i) => inner.put(i), get: (p, s) => inner.get(p, s), delete: (p, s) => inner.delete(p, s), query: (o) => inner.query(o),
    batchPut: async (items) => {
      if (failNodes && items.some((i) => i.entity !== 'GraphIndex')) throw new Error('throttled');
      await inner.batchPut(items);
    },
  });
  try {
    const small: Graph = { nodes: [{ type: 'Facility', id: 'F1', label: 'F1', props: {} }], edges: [] };
    await writeGraph(HHS, small);
    // A rebuild with a new node dies after the index batch, before the nodes.
    failNodes = true;
    const bigger: Graph = { nodes: [...small.nodes, { type: 'Facility', id: 'F2', label: 'F2', props: {} }], edges: [] };
    await assert.rejects(writeGraph(HHS, bigger), /throttled/);
    failNodes = false;
    // The sources drop F2 again. Whatever of it was written must go.
    const result = await writeGraph(HHS, small);
    assert.ok(result.removed >= 1, 'the index entry that got written is cleaned up');
    assert.equal((await inner.query({ pk: 'TENANT#hhs-demo#GRAPH' })).length, 1, 'only F1 is indexed');
    assert.equal((await inner.query({ pk: 'TENANT#hhs-demo#GRAPH#Facility#F2' })).length, 0);
  } finally {
    resetTableStore();
  }
});
