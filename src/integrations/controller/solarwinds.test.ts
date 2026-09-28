/**
 * SolarWinds: which plane each reading comes from, what is and is not a
 * measurement, and the end-to-end claim - a poller with no cloud behind it
 * can corroborate a dead switch and name it as the cause.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now } from '../../platform/clock.ts';
import { setRandom, seededRandom } from '../../platform/random.ts';
import { setUuid, seededUuid } from '../../platform/crypto.ts';
import { isMetric, isEvent, type Principal } from '../../platform/types.ts';
import { loadEstate, getInventory } from '../../geo/device-repository.ts';
import {
  collectOne, collapseDuplicates, detectIncidents, evaluate, normaliseControllers, resolveLocations,
} from '../../pipeline/steps.ts';
import { connectorsFor } from './registry.ts';
import { parseOrionUtc, solarwinds, swisRequest, SWQL } from './solarwinds.ts';

const HHS: Principal = {
  sub: 't', email: 'ops@hhs.texas.example', tenantId: 'hhs-demo',
  roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
};

beforeEach(() => {
  setClock(fixedClock());
  const rng = seededRandom();
  setRandom(rng);
  setUuid(seededUuid(rng));
});

/** Run the real pipeline for the HHS tenant, whose only poller is SolarWinds. */
async function pipeline() {
  loadEstate('hhs-demo');
  const inventory = getInventory(HHS);
  inventory.takeUnresolved();
  const since = new Date(now() - 6 * 3600_000).toISOString();
  const collected = [];
  for (const c of connectorsFor(HHS)) collected.push(await collectOne({ connector: c, input: { principal: HHS, since } }));
  const observations = resolveLocations(HHS, collapseDuplicates(normaliseControllers(HHS, inventory, collected)));
  const unresolved = inventory.takeUnresolved();
  const alarms = evaluate(HHS, observations);
  return { observations, unresolved, alarms, incidents: detectIncidents(HHS, alarms) };
}

test('the resources declare the planes the header argues for', () => {
  const plane = Object.fromEntries(solarwinds.resources.map((r) => [r.name, r.plane]));
  assert.deepEqual(plane, { 'node-status': 'external', 'node-cpu': 'device', interfaces: 'device' });
  assert.deepEqual(connectorsFor(HHS).map((c) => c.controller), ['solarwinds']);
});

test('SWQL: values are bound as parameters, and an undeclared one is refused', () => {
  const r = swisRequest('nodes', { first: 1, last: 500 });
  assert.equal(r.query, SWQL.nodes, 'the query text is never modified');
  assert.throws(() => swisRequest('nodes', { first: 1, last: 500, since: 'x' }), /not declared/);
  assert.throws(() => swisRequest('nodes', { first: 1 }), /needs parameter @last/);
});

test('Orion timestamps: seven fractional digits, no zone - read as UTC, or not at all', () => {
  assert.equal(parseOrionUtc('2026-09-08T14:29:10.1234567'), '2026-09-08T14:29:10.123Z');
  assert.equal(parseOrionUtc('2026-09-08T14:29:10'), '2026-09-08T14:29:10.000Z');
  assert.equal(parseOrionUtc('08/09/2026 14:29'), undefined);
});

test('what is a measurement: Unmanaged, Warning, the -2 CPU sentinel and admin-down ports are not', async () => {
  const { observations, unresolved } = await pipeline();
  const on = (id: string) => observations.filter((o) => o.deviceId === id);
  assert.equal(on('dev-acc-dal01-05').length, 0, 'Unmanaged: muted for maintenance');
  assert.equal(on('dev-acc-dal01-07').length, 0, 'Warning: Orion\'s threshold opinion, not a measurement');
  assert.ok(!on('dev-dis-dal01-04').some((o) => isMetric(o) && o.kind === 'cpu-utilisation'), '-2 is "unknown", not a CPU');
  assert.ok(!on('dev-dis-dal01-03').some((o) => isEvent(o) && o.kind === 'link-state'), 'admin-down is a decision, not a fault');
  // An admin's label resolves by IP; an unknown node is counted and NAMED.
  assert.ok(on('dev-wan-dal01-02').length > 0, 'DAL-WAN-EDGE resolved by its management IP');
  assert.deepEqual(unresolved, ['hhs-ups-mdf-01']);
});

test('reachable devices are ok - the severity bug this connector surfaced stays fixed', async () => {
  const { observations } = await pipeline();
  const reachable = observations.filter((o) => isMetric(o) && o.kind === 'reachability' && o.value === 1);
  assert.ok(reachable.length > 0);
  assert.ok(reachable.every((o) => o.severity === 'ok'));
});

test('a dead distribution switch, with no cloud at all: one incident, anchored at the cause', async () => {
  const { alarms, incidents } = await pipeline();
  const dead = alarms.find((a) => a.deviceId === 'dev-dis-dal01-04')!;
  assert.deepEqual(dead.planes, ['external'], 'the poller\'s ICMP - our side\'s vantage point');
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].rootCauseDeviceId, 'dev-dis-dal01-04');
  assert.deepEqual([...incidents[0].deviceIds].sort(),
    ['dev-acc-dal01-06', 'dev-acc-dal01-08', 'dev-acc-dal01-10', 'dev-dis-dal01-04']);
});

test('interface errors are judged per poll interval, never as Orion\'s running hourly total', () => {
  loadEstate('hhs-demo');
  const inventory = getInventory(HHS);
  const resource = solarwinds.resources.find((r) => r.name === 'interfaces')!;
  const at = (receivedAt: string, thisHour: number) => solarwinds.normalise({
    tenantId: 'hhs-demo', encoding: 'rest-json', receivedAt,
    source: { collector: 'test', resource: 'interfaces' },
    records: [{ InterfaceID: 1, NodeID: 1, NodeCaption: 'cor-dal01-01.acme.internal', NodeIPAddress: '10.11.0.1',
      Name: 'GigabitEthernet1/0/1', OperStatus: 1, AdminStatus: 1, InErrorsThisHour: thisHour, OutErrorsThisHour: 0, LastSync: 'x' }],
  }, inventory, resource).flatMap((o) => (isMetric(o) && o.kind === 'interface-errors' ? [o] : []));

  // A STEADY 30 errors a minute reads the same all hour: 150 per five-minute poll.
  const early = at('2026-09-08T14:15:00.000Z', 30 * 15);
  const late = at('2026-09-08T14:45:00.000Z', 30 * 45);
  assert.deepEqual([early[0].value, late[0].value], [150, 150]);
  assert.equal(early[0].severity, late[0].severity, 'severity does not depend on the minute of the hour');
  // One burst of 150 at :01, nothing since: by :40 it is history, not a warning.
  assert.equal(at('2026-09-08T14:40:00.000Z', 150)[0].severity, 'ok');
  // In the hour's first minutes a burst IS the average - so nothing is judged.
  assert.deepEqual(at('2026-09-08T14:04:00.000Z', 150), []);
});
