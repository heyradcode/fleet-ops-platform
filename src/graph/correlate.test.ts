/**
 * Candidate causes, through the real poll and the real rules.
 *
 * The planted pairs: poor call quality at Houston Regional (LC=1120), from
 * Teams and Webex agreeing - and Houston's WAN edge reporting thousands of
 * interface errors an hour over SNMP, one witness, held back. Nothing pages
 * for the second. The graph puts it beside the first, as a candidate. And
 * sbc2 failing most of its calls, while the switch it runs on in the data
 * centre does the same - joined by the SBC's path, not by a building.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import type { Alarm, Incident, Principal } from '../platform/types.ts';
import { COMMS_CONFIG } from '../integrations/comms/config.ts';
import { generateEstate } from '../data/estate.ts';
import { deriveGraph } from './derive.ts';
import { writeGraph } from './store.ts';
import { HHS_DEMO_TENANT } from '../integrations/comms/config.ts';
import type { CommsIncident } from '../integrations/comms/incidents.ts';
import { commsSnapshot, tenantScenarios, type CommsSnapshot } from '../api/board-api.ts';
import { candidateCauses, type CandidateCauses } from './correlate.ts';
import { HHS_ADMIN as HHS, pollHhsAndBuildGraph } from './test-world.ts';

const who = (tenantId: string): Principal =>
  ({ sub: 'c-' + tenantId, email: 'c@x', tenantId, roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito' });

let snap: CommsSnapshot;

before(async () => {
  await pollHhsAndBuildGraph();
  const s = await commsSnapshot(HHS);
  assert.ok(s);
  snap = s;
});

const incidentAt = (kind: CommsIncident['subject']['kind'], id?: string) =>
  snap.incidents.find((i) => i.subject.kind === kind && (!id || i.subject.id === id));

test('Houston\'s call quality: the WAN edge in the same building is the top candidate - with its path', () => {
  const houston = incidentAt('facility', '1120');
  assert.ok(houston, 'the planted call-quality incident');
  const c = snap.causes[houston.incidentId];
  assert.equal(c.status, 'found');
  if (c.status !== 'found') return;
  const top = c.causes[0];
  assert.equal(top.deviceId, 'dev-wan-hou01-02');
  assert.equal(top.role, 'wan-edge');
  assert.equal(top.what, 'Interface errors');
  assert.equal(top.paged, false, 'one witness: held back, and said so');
  assert.match(top.path, /1120.*LOCATED_AT.*wan-hou01-02/);
  // The building, and only the building: Dallas's cascade is not Houston's cause.
  assert.ok(c.causes.every((x) => x.deviceId.includes('hou01')), c.causes.map((x) => x.deviceId).join());
});

test('a candidate is never evidence: correlating changes neither the network\'s decision nor the incident', () => {
  const network = tenantScenarios(HHS);
  const wan = network.heldBack.find((a) => a.deviceId === 'dev-wan-hou01-02');
  assert.ok(wan, 'still held back - the graph promoted nothing');
  assert.ok(!network.incidents.some((i) => i.siteId === 'hou-01'), 'and no network incident was opened for it');
  assert.equal(incidentAt('facility', '1120')?.severity, 'critical', 'the comms incident is as the comms rules left it');
});

test('sbc2 failing calls: the switch it runs on is the top candidate - by the SBC\'s path, not a building', () => {
  const trunk = incidentAt('trunk', 'sbc2.voice.hhs.texas.example');
  assert.ok(trunk, 'the planted failing-trunk incident');
  const c = snap.causes[trunk.incidentId];
  assert.equal(c.status, 'found');
  if (c.status !== 'found') return;
  const top = c.causes[0];
  assert.equal(top.deviceId, 'dev-acc-adc01-05');
  assert.equal(top.what, 'Interface errors');
  assert.equal(top.paged, false, 'one witness: held back, and said so');
  assert.equal(top.path, 'SBC sbc2.voice.hhs.texas.example -> RUNS_ON -> acc-adc01-05 (access)');
  // Only the data centre's path; Houston's WAN edge is Houston's candidate.
  assert.ok(c.causes.every((x) => x.deviceId.includes('adc01')), c.causes.map((x) => x.deviceId).join());
});

test('"none" says what was searched; queues say why there is no path', () => {
  const lubbock = incidentAt('facility', '3308');
  assert.ok(lubbock);
  const c = snap.causes[lubbock.incidentId];
  assert.equal(c.status, 'none');
  if (c.status === 'none') assert.match(c.searched, /^6 network devices at Lubbock Field Office, 14:15Z to /);

  const queue = incidentAt('queue');
  assert.ok(queue);
  assert.equal(snap.causes[queue.incidentId].status, 'no-path');
});

// ---------------------------------------------------------------------------
// The window, the ranking, and "could not look" - with decisions built by hand
// ---------------------------------------------------------------------------

const OPENED = '2026-09-08T14:30:00.000Z';
const houstonIncident = (): CommsIncident => ({ ...incidentAt('facility', '1120')!, openedAt: OPENED });
const alarm = (id: string, deviceId: string, raisedAt: string, severity: Alarm['severity'] = 'warning'): Alarm => ({
  tenantId: HHS_DEMO_TENANT, alarmId: id, deviceId, siteId: 'hou-01', kind: 'link-down', severity,
  observationIds: [], planes: ['device'], location: { lon: 0, lat: 0 }, raisedAt,
});

test('the window is [opened - 15 min, now]: an hour-old alarm is history, not a candidate', async () => {
  const c: CandidateCauses = await candidateCauses(HHS, houstonIncident(), {
    alarms: [
      alarm('old', 'dev-cor-hou01-01', '2026-09-08T13:30:00.000Z'),
      alarm('recent', 'dev-cor-hou01-01', '2026-09-08T14:20:00.000Z'),
      alarm('after', 'dev-cor-hou01-01', '2026-09-08T14:34:00.000Z'),
      alarm('future', 'dev-cor-hou01-01', '2026-09-08T16:00:00.000Z'),
    ],
    incidents: [], heldBack: [],
  }, '2026-09-08T14:35:00.000Z');
  assert.equal(c.status, 'found');
  if (c.status !== 'found') return;
  assert.deepEqual(c.causes.map((x) => x.id).sort(), ['after', 'recent']);
  assert.equal(c.causes.find((x) => x.id === 'recent')?.minutesBefore, 10);
  assert.equal(c.causes.find((x) => x.id === 'after')?.minutesBefore, -4);
});

test('ranked worst first, and an incident that paged lists once - not once per alarm inside it', async () => {
  const inc: Incident = {
    tenantId: HHS_DEMO_TENANT, incidentId: 'inc-1', title: 'Houston core unreachable', severity: 'critical',
    status: 'open', siteId: 'hou-01', deviceIds: ['dev-cor-hou01-01'], alarmIds: ['a-in-incident'],
    rootCauseDeviceId: 'dev-cor-hou01-01', openedAt: '2026-09-08T14:25:00.000Z',
  };
  const c = await candidateCauses(HHS, houstonIncident(), {
    alarms: [alarm('a-in-incident', 'dev-cor-hou01-01', '2026-09-08T14:25:00.000Z', 'critical'),
      alarm('a-minor', 'dev-wan-hou01-02', '2026-09-08T14:29:00.000Z', 'warning')],
    incidents: [inc], heldBack: [],
  }, '2026-09-08T14:35:00.000Z');
  assert.equal(c.status, 'found');
  if (c.status !== 'found') return;
  assert.deepEqual(c.causes.map((x) => x.id), ['inc-1', 'a-minor']);
  assert.equal(c.causes[0].paged, true);
});

// --- A trunk's path: up, then out, and never sideways ------------------------

const sbc2Incident = (): CommsIncident => ({ ...incidentAt('trunk', 'sbc2.voice.hhs.texas.example')!, openedAt: OPENED });
const adcAlarm = (id: string, deviceId: string, severity: Alarm['severity'] = 'warning'): Alarm =>
  ({ ...alarm(id, deviceId, '2026-09-08T14:29:00.000Z', severity), siteId: 'adc-01' });

test('a trunk\'s path is its switch, up the chain, out through the WAN edge - nearer first, and the sibling never', async () => {
  const c = await candidateCauses(HHS, sbc2Incident(), {
    alarms: [
      adcAlarm('wan', 'dev-wan-adc01-02'),
      adcAlarm('core', 'dev-cor-adc01-01'),
      adcAlarm('dist', 'dev-dis-adc01-03'),
      adcAlarm('switch', 'dev-acc-adc01-05'),
      // SBC1's switch: the same parent, a worse alarm - and not on sbc2's path.
      adcAlarm('sibling', 'dev-acc-adc01-04', 'critical'),
    ],
    incidents: [], heldBack: [],
  }, '2026-09-08T14:35:00.000Z');
  assert.equal(c.status, 'found');
  if (c.status !== 'found') return;
  assert.deepEqual(c.causes.map((x) => x.id), ['switch', 'dist', 'core', 'wan'], 'same severity: nearer on the path first');
  assert.match(c.causes[3].path, /-> UPLINKS_TO -> cor-adc01-01 \(core\) -> out through wan-adc01-02 \(wan-edge\)$/);
  // Nothing raised on it: "none", naming the path it searched - four devices, not the site's five.
  const quiet = await candidateCauses(HHS, sbc2Incident(), { alarms: [adcAlarm('sibling', 'dev-acc-adc01-04', 'critical')], incidents: [], heldBack: [] }, '2026-09-08T14:35:00.000Z');
  assert.equal(quiet.status, 'none');
  if (quiet.status === 'none') assert.match(quiet.searched, /^4 network devices on the path of sbc2\.voice\.hhs\.texas\.example \(its switch, up to the core, out through the WAN edge\), 14:15Z to 14:35Z$/);
});

test('a trunk with no path says which link is missing: not an SBC, or an SBC nobody placed', async () => {
  // An unmapped Bandwidth peer keeps its own name and still pages; it is no SBC.
  const peer = await candidateCauses(HHS, { ...sbc2Incident(), subject: { kind: 'trunk', id: '540103', name: '540103' } },
    { alarms: [], incidents: [], heldBack: [] }, OPENED);
  assert.equal(peer.status, 'no-path');
  assert.match((peer as { reason: string }).reason, /540103 is not an SBC in the knowledge graph/);

  // A graph built without the sbcSwitch table has the SBC but not its switch.
  const unplaced = who('correlate-no-switch');
  const estate = generateEstate(HHS_DEMO_TENANT);
  await writeGraph(unplaced, deriveGraph({
    sites: estate.sites, devices: estate.devices, config: { ...COMMS_CONFIG[HHS_DEMO_TENANT], sbcSwitch: undefined },
  }));
  const c = await candidateCauses(unplaced, sbc2Incident(), { alarms: [], incidents: [], heldBack: [] }, OPENED);
  assert.equal(c.status, 'no-path');
  assert.match((c as { reason: string }).reason, /no source says which network device sbc2\.voice\.hhs\.texas\.example sits behind/);
});

test('an uplink loop in bad data ends the walk - it does not spin', async () => {
  const looped = who('correlate-loop');
  const dev = (id: string) => ({ type: 'Device' as const, id });
  await writeGraph(looped, {
    nodes: [
      { type: 'Sbc', id: 'sbc.x', label: 'sbc.x', props: {} },
      { ...dev('a'), label: 'a', props: { role: 'access' } },
      { ...dev('b'), label: 'b', props: { role: 'distribution' } },
    ],
    edges: [
      { from: { type: 'Sbc', id: 'sbc.x' }, rel: 'RUNS_ON', to: dev('a') },
      { from: dev('a'), rel: 'UPLINKS_TO', to: dev('b') },
      { from: dev('b'), rel: 'UPLINKS_TO', to: dev('a') },
    ],
  });
  const c = await candidateCauses(looped, { ...sbc2Incident(), subject: { kind: 'trunk', id: 'sbc.x', name: 'sbc.x' } },
    { alarms: [adcAlarm('on-b', 'b')], incidents: [], heldBack: [] }, '2026-09-08T14:35:00.000Z');
  assert.equal(c.status, 'found');
  if (c.status === 'found') assert.deepEqual(c.causes.map((x) => [x.id, x.path]), [['on-b', 'SBC sbc.x -> RUNS_ON -> a (access) -> UPLINKS_TO -> b (distribution)']]);
});

test('no graph for the tenant: "unknown", never a quiet "none"', async () => {
  const other = who('correlate-no-graph');
  const c = await candidateCauses(other, { ...houstonIncident(), tenantId: other.tenantId }, { alarms: [], incidents: [], heldBack: [] }, OPENED);
  assert.equal(c.status, 'unknown');
});

test('the brief the board builds carries the same top candidate, in plain words, and says "candidate"', async () => {
  const { renderBrief } = await import('../reporting/daily-brief.ts');
  const houston = snap.brief.open.find((i) => i.id === incidentAt('facility', '1120')?.incidentId);
  assert.equal(houston?.networkCandidate,
    'On the building\'s own network: interface errors on its WAN edge (wan-hou01-02), reported by the device alone');
  assert.equal(snap.brief.open.find((i) => i.id === incidentAt('trunk', 'sbc2.voice.hhs.texas.example')?.incidentId)?.networkCandidate,
    'On the SBC\'s path to the carrier: interface errors on its access switch (acc-adc01-05), reported by the device alone',
    'a trunk is in no building, and the brief does not say it is');
  assert.equal(snap.brief.open.find((i) => i.id === incidentAt('facility', '3308')?.incidentId)?.networkCandidate, undefined,
    'looked and found nothing: the brief names nothing');
  assert.match(renderBrief(snap.brief, 'text'), /reported by the device alone - a candidate, not a confirmed cause/);
});

test('a network incident still OPEN counts whenever it opened; a RESOLVED one is over, even inside the window', async () => {
  const incident = (id: string, openedAt: string, status: Incident['status']): Incident => ({
    tenantId: HHS_DEMO_TENANT, incidentId: id, title: id, severity: 'critical', status, siteId: 'hou-01',
    deviceIds: ['dev-wan-hou01-02'], alarmIds: [], rootCauseDeviceId: 'dev-wan-hou01-02', openedAt,
  });
  const c = await candidateCauses(HHS, houstonIncident(), {
    alarms: [], heldBack: [],
    incidents: [incident('still-going', '2026-09-08T13:30:00.000Z', 'open'), incident('over', '2026-09-08T14:25:00.000Z', 'resolved')],
  }, '2026-09-08T14:35:00.000Z');
  assert.equal(c.status, 'found', 'an hour-old outage that is still open was reported as "looked, found nothing"');
  if (c.status === 'found') assert.deepEqual(c.causes.map((x) => x.id), ['still-going']);
});

test('the graph is built but the subject is not in it: "no-path", not "the graph has not been built"', async () => {
  // An unmapped satellite terminal becomes a facility subject with no facility.
  const c = await candidateCauses(HHS, { ...houstonIncident(), subject: { kind: 'facility', id: 'starlink-terminal:ut01-van', name: 'the mobile van' } },
    { alarms: [], incidents: [], heldBack: [] }, OPENED);
  assert.equal(c.status, 'no-path');
  assert.match((c as { reason: string }).reason, /the mobile van is not a facility in the knowledge graph/);
});

test('a graph read that fails costs that incident its candidates - never the comms view or the brief', async () => {
  const { causesForIncidents } = await import('./correlate.ts');
  const siteScoped: Principal = { ...HHS, scope: { kind: 'site', siteId: 'hou-01' } };   // graph reads refuse it
  const causes = await causesForIncidents(siteScoped, [houstonIncident()], { alarms: [], incidents: [], heldBack: [] }, OPENED);
  assert.equal(causes[houstonIncident().incidentId].status, 'unknown');
});

test('"now" is read BEFORE the scenarios reseed the world - a board read at 15:00 searches to 15:00', async () => {
  const { setClock, fixedClock } = await import('../platform/clock.ts');
  setClock(fixedClock('2026-09-08T15:00:00.000Z'));
  const later = await commsSnapshot(HHS);
  const lubbock = later?.incidents.find((i) => i.subject.id === '3308');
  const c = lubbock ? later!.causes[lubbock.incidentId] : undefined;
  assert.equal(c?.status, 'none');
  assert.match((c as { searched: string }).searched, /to 15:00Z$/);
});
