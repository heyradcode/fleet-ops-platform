/**
 * The graph tools: a fixed catalogue, typed and bounded, offered to the
 * callers the graph is for - and saying "candidate" wherever it means it.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import type { Principal } from '../platform/types.ts';
import { setRunbooks } from '../platform/runbook-loader.ts';
import { loadRunbooksFromDisk } from '../platform/runbook-loader.node.ts';
import { HHS_ADMIN, pollHhsAndBuildGraph } from '../graph/test-world.ts';
import { prepareToolWorld, runTool } from './tool-provider.ts';
import { toolSpecsFor } from './tools.ts';
import { runAgent } from './agent-core.ts';
import { handleMcpMessage } from './mcp/server.ts';
import { graphToolsFor, MAX_NODES, resolveFacility } from './graph-tools.ts';

const HHS_OPERATOR: Principal = { ...HHS_ADMIN, sub: 'hou-op', roles: ['operator'], scope: { kind: 'site', siteId: 'hou-01' } };
const ACME_ADMIN: Principal = { ...HHS_ADMIN, sub: 'acme', tenantId: 'acme-networks' };
const GRAPH = ['whatServes', 'explainIncident', 'graphNeighbours'];

before(async () => {
  setRunbooks(loadRunbooksFromDisk());
  await pollHhsAndBuildGraph();
});

test('a facility by code or by name - and the longer name wins, so North Austin is not Austin', () => {
  assert.equal(resolveFacility(HHS_ADMIN, '1120'), '1120');
  assert.equal(resolveFacility(HHS_ADMIN, 'Why is call quality bad in Houston?'), '1120');
  assert.equal(resolveFacility(HHS_ADMIN, 'what about north austin'), '0417');
  assert.equal(resolveFacility(HHS_ADMIN, 'Austin Central'), '0412');
  assert.equal(resolveFacility(HHS_ADMIN, 'El Paso'), '2031');
  assert.equal(resolveFacility(HHS_ADMIN, 'the moon'), undefined);
  assert.equal(resolveFacility(HHS_ADMIN, '9999'), undefined, 'a code the tenant does not have is not a facility');
});

test('offered with the comms tools, to the same callers: not a site operator, not a tenant with no facilities', () => {
  assert.deepEqual(graphToolsFor(HHS_ADMIN).map((t) => t.name), GRAPH);
  assert.deepEqual(graphToolsFor(HHS_OPERATOR), []);
  assert.deepEqual(graphToolsFor(ACME_ADMIN), []);
  assert.ok(GRAPH.every((n) => toolSpecsFor(HHS_ADMIN, { readOnly: true }).some((t) => t.name === n)), 'read-only, so the deployed agent gets them');
});

test('whatServes: the building\'s network, its satellite WAN, and a people COUNT - never a name', async () => {
  const out = await runTool('whatServes', { facility: 'Lubbock' }, HHS_ADMIN);
  assert.match(out, /^FACILITY 3308 Lubbock Field Office - \d+ people \(a count, never names\)/);
  assert.match(out, /network: 6 devices: .*wan-lbb01-02 \(wan-edge/);
  assert.match(out, /satellite WAN: SatelliteTerminal ut01000000-00000000-00d4e5f6/);
  assert.match(out, /not "none exist"/, 'an unmapped SBC is said as unmapped');
  assert.ok(!out.includes('@'));
  assert.match(await runTool('whatServes', { facility: 'the moon' }, HHS_ADMIN), /^ERROR: .*Known facilities: 0412/);
});

test('explainIncident: candidates are called candidates, and a wrong id teaches the right ones', async () => {
  const out = await runTool('explainIncident', {}, HHS_ADMIN);
  assert.match(out, /CANDIDATE \(not evidence\) wan-hou01-02 \(wan-edge\): Interface errors, critical, held back - one witness, it paged nobody/);
  assert.match(out, /looked, found nothing: nothing raised on 6 network devices at Lubbock/);
  assert.match(out, /a contact-centre queue is not a place on the network/);
  assert.match(await runTool('explainIncident', { incidentId: 'cinc-nope' }, HHS_ADMIN), /^ERROR: no open comms incident "cinc-nope"\. Open ones: cinc-/);
});

test('graphNeighbours: depth is capped at 2 whatever is asked, the node count too, and every hop names its parent', async () => {
  const deep = await runTool('graphNeighbours', { node: 'Device#dev-cor-dal01-01', depth: 9 }, HHS_ADMIN);
  const lines = deep.split('\n');
  assert.ok(!lines.some((l) => l.includes('hop 3')), 'no third hop, however deep the question');
  assert.ok(lines.filter((l) => l.includes('hop ')).length <= MAX_NODES);
  assert.ok(lines.some((l) => /hop 2: Device dis-dal01-0\d .* <- UPLINKS_TO <- Device acc-dal01/.test(l)), 'a hop-2 line says what it hangs off');
  const facility = await runTool('graphNeighbours', { node: 'Houston', relation: 'LOCATED_AT' }, HHS_ADMIN);
  assert.equal(facility.split('\n').filter((l) => l.includes('LOCATED_AT')).length, 11);
  assert.match(await runTool('graphNeighbours', { node: 'nothing here' }, HHS_ADMIN), /^ERROR: cannot read a node/);
  assert.match(await runTool('graphNeighbours', { node: 'Device#dev-nope-01' }, HHS_ADMIN), /has no Device#dev-nope-01/);
});

test('behind the MCP server like every tool: listed read-only, called and scoped per caller', async () => {
  const list = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, HHS_ADMIN, { audit: async () => {} });
  assert.ok(list && 'result' in list);
  const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.ok(GRAPH.every((n) => names.includes(n)));
  // A site operator was never listed them, so calling one is refused.
  const refused = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whatServes', arguments: { facility: '1120' } } },
    HHS_OPERATOR, { audit: async () => {} });
  assert.ok(refused && 'error' in refused);
});

test('the assistant asks the graph and gets an answer - no tool error on the way', async () => {
  await prepareToolWorld(HHS_ADMIN);
  const result = await runAgent({
    question: 'Why is call quality bad in Houston?',
    principal: HHS_ADMIN,
    tools: toolSpecsFor(HHS_ADMIN, { readOnly: true }),
  });
  assert.equal(result.stoppedBecause, 'end_turn');
  for (const name of GRAPH) {
    const step = result.trace.find((s) => s.kind === 'tool' && s.detail.startsWith(name + '('));
    assert.ok(step, name + ' was used');
    assert.ok(!step.detail.endsWith('-> error'), step.detail);
  }
});

test('graphNeighbours returns EXACTLY the node cap, and says it stopped', async () => {
  const { writeGraph } = await import('../graph/store.ts');
  const hub: Principal = { ...HHS_ADMIN, tenantId: 'graph-cap-tenant' };
  const spokes = Array.from({ length: 60 }, (_, i) => ({ type: 'Device' as const, id: 'd' + String(i).padStart(2, '0'), label: 'd' + i, props: {} }));
  await writeGraph(hub, {
    nodes: [{ type: 'Facility', id: 'HUB', label: 'Hub', props: {} }, ...spokes],
    edges: spokes.map((s) => ({ from: { type: 'Device' as const, id: s.id }, rel: 'LOCATED_AT' as const, to: { type: 'Facility' as const, id: 'HUB' } })),
  });
  const out = await runTool('graphNeighbours', { node: 'Facility#HUB', depth: 2 }, hub);
  assert.equal(out.split('\n').filter((l) => l.includes('hop ')).length, MAX_NODES, 'not MAX_NODES + 1');
  assert.match(out, /stopped at 40 nodes/);
});
