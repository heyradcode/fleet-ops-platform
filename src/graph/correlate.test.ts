/**
 * Candidate causes, through the real poll and the real rules.
 *
 * The planted pair: poor call quality at Houston Regional (LC=1120), from
 * Teams and Webex agreeing - and Houston's WAN edge reporting thousands of
 * interface errors an hour over SNMP, one witness, held back. Nothing pages
 * for the second. The graph puts it beside the first, as a candidate.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import type { Alarm, Incident, Principal } from '../platform/types.ts';
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

test('"none" says what was searched; trunks and queues say why there is no path', () => {
  const lubbock = incidentAt('facility', '3308');
  assert.ok(lubbock);
  const c = snap.causes[lubbock.incidentId];
  assert.equal(c.status, 'none');
  if (c.status === 'none') assert.match(c.searched, /^6 network devices at Lubbock Field Office, 14:15Z to /);

  const trunk = incidentAt('trunk');
  const queue = incidentAt('queue');
  assert.ok(trunk && queue);
  assert.equal(snap.causes[trunk.incidentId].status, 'no-path');
  assert.match((snap.causes[trunk.incidentId] as { reason: string }).reason, /sits behind/);
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

test('no graph for the tenant: "unknown", never a quiet "none"', async () => {
  const other = who('correlate-no-graph');
  const c = await candidateCauses(other, { ...houstonIncident(), tenantId: other.tenantId }, { alarms: [], incidents: [], heldBack: [] }, OPENED);
  assert.equal(c.status, 'unknown');
});

test('the brief the board builds carries the same top candidate, in plain words, and says "candidate"', async () => {
  const { renderBrief } = await import('../reporting/daily-brief.ts');
  const houston = snap.brief.open.find((i) => i.id === incidentAt('facility', '1120')?.incidentId);
  assert.equal(houston?.networkCandidate,
    'On the building\'s own network: interface errors on its wan edge (wan-hou01-02), reported by the device alone');
  assert.equal(snap.brief.open.find((i) => i.id === incidentAt('facility', '3308')?.incidentId)?.networkCandidate, undefined,
    'looked and found nothing: the brief names nothing');
  assert.match(renderBrief(snap.brief, 'text'), /reported by the device alone - a candidate, not a confirmed cause/);
});
