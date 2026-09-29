/**
 * CUCM RisPort70: desk-phone registration, asked by name, paced to a shared
 * allowance, and never a word about the people who use the phones.
 *
 * Each poll test runs as its own tenant: health and incidents carry history.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now, type ControllableClock } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_CUCM_USER, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN,
  directory, injectFault, kurmiPhones, mockFetch, plantedDeskPhones, PLANTED_DESK_PHONES, resetMockState, setCucmNodeDown,
  setCucmRateLimit, setPlanted, TEAMS_PLANTED,
} from './mock/index.ts';
import { createCommsClient, type CommsClient, type CommsCredentials } from './client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { runCommsPoll } from './poll.ts';
import {
  deskPhoneSeverity, MAX_RIS_REQUESTS_PER_POLL, parseSelect, RIS_BATCH, readRegistrations, selectEnvelope,
  summariseRegistrations, type DeskPhone, type RegistrationRead, type RisDevice,
} from './cucm.ts';

let clock: ControllableClock;
beforeEach(() => {
  clock = fixedClock();
  setClock(clock);
  resetMockState();
});

function client(tenantId = HHS_DEMO_TENANT, cucm: CommsCredentials['cucm'] = { ...DEMO_CUCM_USER }, sleep = async (_ms: number) => {}) {
  return createCommsClient({
    tenantId, fetch: mockFetch, sleep,
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
      genesys: { ...DEMO_CLIENT }, webex: { token: DEMO_WEBEX_TOKEN }, bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER }, kurmi: { ...DEMO_KURMI_USER }, cucm, starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
    },
  });
}

function setup(tenantId: string, cucm?: CommsCredentials['cucm']) {
  const config = { ...structuredClone(COMMS_CONFIG[HHS_DEMO_TENANT]), tenantId };
  const principal: Principal = {
    sub: 't', email: 'ops@hhs.texas.example', tenantId, roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  const c = client(tenantId, cucm);
  return { principal, poll: () => runCommsPoll(principal, c, config, now()) };
}

const EL_PASO = PLANTED_DESK_PHONES.facility;
const PEOPLE = /Pat Example|em\.user|\d{4}-(Registered|UnRegistered)/;

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

test('the request is selectCmDeviceExt by NAME, every name escaped - never a wildcard', () => {
  const xml = selectEnvelope(['SEP001122334455', 'SEP<&>"']);
  assert.match(xml, /<soap:selectCmDeviceExt>/);
  assert.match(xml, /<soap:SelectBy>Name<\/soap:SelectBy>/);
  assert.match(xml, /<soap:Item>SEP001122334455<\/soap:Item>/);
  assert.match(xml, /<soap:Item>SEP&lt;&amp;&gt;&quot;<\/soap:Item>/);
  assert.ok(!xml.includes('*'));
});

const answer = (nodes: string, found?: number) =>
  '<Envelope><Body><selectCmDeviceExtResponse><selectCmDeviceReturn><SelectCmDeviceResult>' +
  (found === undefined ? '' : '<TotalDevicesFound>' + found + '</TotalDevicesFound>') +
  '<CmNodes>' + nodes + '</CmNodes></SelectCmDeviceResult></selectCmDeviceReturn></selectCmDeviceExtResponse></Body></Envelope>';
const node = (code: string, devices: string) => '<item><ReturnCode>' + code + '</ReturnCode><Name>sub1</Name><CmDevices>' + devices + '</CmDevices></item>';
const device = (name: string, status: string, reason: number) =>
  '<item><Name>' + name + '</Name><Status>' + status + '</Status><StatusReason>' + reason + '</StatusReason><TimeStamp>1757340000</TimeStamp></item>';

test('case is not trusted: Ok, OK, UnRegistered and unregistered all read the same', () => {
  const devices = parseSelect(answer(
    node('Ok', device('sepaa', 'UnRegistered', 13)) + node('OK', device('SEPBB', 'registered', 0)), 2), 2);
  assert.deepEqual(devices.map((d) => [d.name, d.status, d.reason]), [['SEPAA', 'unregistered', 13], ['SEPBB', 'registered', 0]]);
  assert.equal(devices[0].changedAt, 1757340000 * 1000, 'epoch SECONDS in, ms out');
});

test('a node that did not answer fails the read, named - it is the cluster, not a building', () => {
  assert.throws(() => parseSelect(answer(node('Ok', '') + '<item><ReturnCode>NodeNotResponding</ReturnCode><Name>cucm-sub2</Name></item>'), 1),
    /node cucm-sub2 answered NodeNotResponding/);
  // NotFound is an answer: none of the asked phones is on that node.
  assert.deepEqual(parseSelect(answer(node('NotFound', '')), 1), []);
});

test('a Fault is a failure; an answer at the ceiling is refused - it may have stopped short and not said', () => {
  assert.throws(() => parseSelect('<Envelope><Body><Fault><faultstring>Exceeded allowed rate</faultstring></Fault></Body></Envelope>', 1),
    /SOAP Fault: Exceeded allowed rate/);
  const full = Array.from({ length: 2000 }, (_, i) => device('SEP' + String(i).padStart(12, '0'), 'Registered', 0)).join('');
  assert.throws(() => parseSelect(answer(node('Ok', full), 2000), 2000), /ceiling may be truncated/);
  assert.throws(() => parseSelect(answer(node('Ok', device('SEPAA', 'Registered', 0) + device('SEPBB', 'Registered', 0))), 1),
    /asked about 1 phones and got 2/);
});

test('TotalDevicesFound is not trusted either way, and the same phone twice is not an error', () => {
  // Ext's count for a phone that registered on two nodes is undocumented; a
  // count larger than the devices returned must not fail a good read.
  const twice = parseSelect(answer(
    node('Ok', device('SEPAA', 'UnRegistered', 13)) + node('Ok', device('SEPAA', 'Registered', 0)), 2), 1);
  assert.equal(twice.length, 2, 'both kept here - readRegistrations keeps the latest');
});

// ---------------------------------------------------------------------------
// Batching, pacing, the budget
// ---------------------------------------------------------------------------

/** A stand-in cluster that says every asked phone is registered, and counts. */
function countingClient(): { client: CommsClient; asked: number[]; waits: number[] } {
  const asked: number[] = [];
  const waits: number[] = [];
  const c = client(HHS_DEMO_TENANT, { ...DEMO_CUCM_USER }, async (ms) => { waits.push(ms); });
  const stub: CommsClient = {
    ...c,
    async request(_source, _url, init) {
      const names = [...String(init?.body).matchAll(/<soap:Item>([^<]+)<\/soap:Item>/g)].map((m) => m[1]);
      asked.push(names.length);
      return new Response(answer(node('Ok', names.map((n) => device(n, 'Registered', 0)).join('')), names.length));
    },
    sleep: async (ms) => { waits.push(ms); },
  };
  return { client: stub, asked, waits };
}

const phones = (facility: string, n: number, from = 0): DeskPhone[] =>
  Array.from({ length: n }, (_, i) => ({ name: 'SEP' + facility + String(from + i).padStart(8, '0'), facility }));

test('batches of RIS_BATCH, paced to the tenant\'s share of the cluster\'s allowance', async () => {
  const { client: c, asked, waits } = countingClient();
  const read = await readRegistrations(c, phones('A', 1100), 10);
  assert.deepEqual(asked, [RIS_BATCH, RIS_BATCH, 100]);
  assert.deepEqual(waits, [6000, 6000], 'ten a minute: six seconds apart, and no wait before the first');
  assert.equal(read.devices.size, 1100);
  assert.deepEqual(read.notAsked, []);
});

test('the per-poll budget leaves WHOLE buildings unmeasured, never every building partly measured', async () => {
  const { client: c, asked } = countingClient();
  const all = [...phones('C', 600), ...phones('A', 4800), ...phones('B', 5000)];
  const read = await readRegistrations(c, all, 60);
  assert.equal(asked.length, MAX_RIS_REQUESTS_PER_POLL);
  const report = summariseRegistrations(all, read, now());
  assert.deepEqual(report.unmeasuredFacilities, ['C'], 'C straddled the budget: not measured at all');
  assert.deepEqual(report.byFacility.map((f) => [f.facility, f.measured]), [['A', 4800], ['B', 5000]]);
});

test('paced to the share, the cluster\'s rate limit is never hit; unpaced, it would be', async () => {
  setCucmRateLimit(2);
  const many = phones('A', 1100);   // three requests; none of these names exist, which is fine here
  const paced = client(HHS_DEMO_TENANT, { ...DEMO_CUCM_USER }, async (ms) => { clock.advance(ms); });
  const read = await readRegistrations(paced, many, 2);
  assert.equal(read.requests, 3);

  resetMockState();
  setCucmRateLimit(2);
  await assert.rejects(readRegistrations(client(), many, 2), /Exceeded allowed rate/);
});

// ---------------------------------------------------------------------------
// Which unregistrations count
// ---------------------------------------------------------------------------

test('only the NETWORK drops a phone; decisions, dormant desks, config and unknowns are kept apart', () => {
  const at = Date.parse('2026-09-08T14:30:00Z');
  const ps = phones('X', 9);
  const d = (i: number, status: RisDevice['status'], reason: number, agoMs = 60_000): [string, RisDevice] =>
    [ps[i].name, { name: ps[i].name, status, reason, changedAt: at - agoMs }];
  const read: RegistrationRead = {
    requests: 1, notAsked: [],
    devices: new Map([
      d(0, 'registered', 0), d(1, 'registered', 0),
      d(2, 'unregistered', 13), d(3, 'unregistered', 6),       // the network: dropped
      d(4, 'unregistered', 34),                                // ManualPowerOff: decided
      d(5, 'unregistered', 13, 30 * 24 * 3600_000),            // a month ago: dormant
      d(6, 'rejected', 14),                                    // configuration
      d(7, 'unregistered', 8),                                 // DeviceInitiatedReset: measured, not dropped
      // ps[8]: no record at all
    ]),
  };
  const r = summariseRegistrations(ps, read, at);
  assert.deepEqual(r.byFacility[0], {
    facility: 'X', measured: 5, dropped: 2, byReason: { ConnectivityError: 1, KeepAliveTimeout: 1 }, decided: 1, misconfigured: 1,
  });
  assert.equal(r.dormant, 1);
  assert.equal(r.noRecord, 1);
});

test('a rate needs phones, and a high one needs enough of them down to be news', () => {
  const f = (measured: number, dropped: number) => ({ facility: 'X', measured, dropped, byReason: {}, decided: 0, misconfigured: 0 });
  assert.equal(deskPhoneSeverity(f(4, 4)), undefined, 'four phones is no rate at all');
  assert.equal(deskPhoneSeverity(f(5, 2)), 'ok', 'two of five is 40% and still not news');
  assert.equal(deskPhoneSeverity(f(10, 3)), 'warning');
  assert.equal(deskPhoneSeverity(f(10, 5)), 'critical');
  assert.equal(deskPhoneSeverity(f(40, 3)), 'ok', '3 of 40 is under the line');
});

// ---------------------------------------------------------------------------
// Through the real poll
// ---------------------------------------------------------------------------

test('El Paso\'s phones dropped off: an incident from the call control alone - and nobody else could see it', async () => {
  const { poll } = setup('cucm-elp');
  const r = await poll();
  const elPaso = r.incidents.find((i) => i.subject.id === EL_PASO);
  assert.ok(elPaso, 'the planted desk-phone outage');
  assert.deepEqual(elPaso.kinds, ['desk-phone-registration']);
  assert.deepEqual(elPaso.sources, ['cucm'], 'no second witness exists to ask: self-evident');
  assert.equal(elPaso.severity, 'critical');
  assert.match(elPaso.title, /^Desk phones dropping off the call control at LC=2031$/);
  const planted = plantedDeskPhones();
  const figure = elPaso.figures[0];
  assert.equal(Math.round(figure.value * figure.sampleSize), planted.dropped);
  assert.match(elPaso.evidence[0], /desk phones at LC=2031 dropped off the call control - the network lost them \(ConnectivityError \d+, KeepAliveTimeout \d+\)/);

  // One Houston phone dropped too - under the line, so Houston is about call quality only.
  const houston = r.incidents.find((i) => i.subject.id === TEAMS_PLANTED.degradedFacility)!;
  assert.ok(!houston.kinds.includes('desk-phone-registration'));
  assert.equal(r.health.sources.find((s) => s.source === 'cucm')?.status, 'healthy');
  const quality = r.health.dataQuality.map((q) => q.kind);
  assert.ok(quality.includes('dormant-desk-phone') && quality.includes('no-registration-record'));
});

test('the answer carries people; nothing the poll keeps does - and no phone name either', async () => {
  // Not vacuous: the cluster's answer really does name people.
  const c = client();
  const raw = await (await c.request('cucm', c.endpoints.cucmRis, {
    method: 'POST', headers: { 'Content-Type': 'text/xml', Accept: 'text/xml' },
    body: selectEnvelope(kurmiPhones().map((p) => p.ciscoName)),
  })).text();
  assert.ok(PEOPLE.test(raw), 'the mock must carry LoginUserId, Description and an extension, or this proves nothing');
  const { poll } = setup('cucm-people');
  const r = await poll();
  const kept = JSON.stringify({ signals: r.signals, alarms: r.alarms, incidents: r.incidents, health: r.health, phones: r.phones });
  assert.ok(!PEOPLE.test(kept), 'LoginUserId, Description or an extension got through');
  assert.ok(!/SEP[0-9A-F]{12}/.test(kept), 'a device name got through');
});

test('Kurmi down: the call control is NOT ASKED - a gap, not an outage - and El Paso cannot resolve on it', async () => {
  const { poll } = setup('cucm-no-kurmi');
  await poll();
  setPlanted(false);
  injectFault('kurmi', 503, 1000);
  const r = await poll();
  const cucm = r.health.sources.find((s) => s.source === 'cucm')!;
  assert.equal(cucm.status, 'degraded', 'not "down": nothing is wrong with CUCM');
  assert.match(cucm.gaps.join(), /not asked this poll: no phone list/);
  assert.equal(r.health.sources.find((s) => s.source === 'kurmi')?.status, 'down');
  const elPaso = r.incidents.find((i) => i.subject.id === EL_PASO)!;
  assert.ok(elPaso, 'still open: not asked is not recovered');
  assert.equal(elPaso.clearPolls, 0);
});

test('a node not responding is the source DOWN, named - not a building\'s phones', async () => {
  const { poll } = setup('cucm-node');
  setCucmNodeDown('cucm-sub2');
  const r = await poll();
  const cucm = r.health.sources.find((s) => s.source === 'cucm')!;
  assert.equal(cucm.status, 'down');
  assert.match(cucm.lastError!, /cucm-sub2 answered NodeNotResponding/);
  assert.ok(!r.incidents.some((i) => i.subject.id === EL_PASO), 'no half-read opens anything');
});

test('a wrong password is a 401, and the source is down with it', async () => {
  const { poll } = setup('cucm-401', { username: DEMO_CUCM_USER.username, password: 'wrong' });
  const r = await poll();
  const cucm = r.health.sources.find((s) => s.source === 'cucm')!;
  assert.equal(cucm.status, 'down');
  assert.match(cucm.lastError!, /\[cucm\] 401/);
});

test('a RisPort 500 is NOT retried at once: the allowance it would spend is shared', async () => {
  // One fault. Any retry would succeed - so success here would mean we retried.
  injectFault('cucm', 500, 1);
  await assert.rejects(readRegistrations(client(), phones('A', 3), 10), /\[cucm\] 500/);
});

test('recovered phones are a MEASUREMENT: El Paso resolves after three healthy reads, like everything else', async () => {
  const { poll } = setup('cucm-recover');
  await poll();
  setPlanted(false);
  for (let n = 0; n < 2; n++) {
    clock.advance(5 * 60_000);
    assert.ok((await poll()).incidents.some((i) => i.subject.id === EL_PASO), 'not yet');
  }
  clock.advance(5 * 60_000);
  const third = await poll();
  assert.ok(third.resolved.some((i) => i.subject.id === EL_PASO));
});
