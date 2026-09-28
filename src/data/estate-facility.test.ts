/**
 * The facility join: every HHS network site is a facility the comms sources
 * know, by the same code - and nothing else about the estates moved.
 *
 * This is the knowledge graph's prerequisite (docs/12, Part 3). Without it,
 * Houston's call quality and Houston's network are two graphs side by side.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { Principal } from '../platform/types.ts';
import { setRandom, seededRandom } from '../platform/random.ts';
import { generateEstate } from './estate.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from '../integrations/comms/config.ts';
import { devicesAtFacility, facilityOfDevice, loadEstate } from '../geo/device-repository.ts';

const who = (tenantId: string, roles: Principal['roles'], scope: Principal['scope']): Principal =>
  ({ sub: 'f-' + tenantId, email: 'f@x', tenantId, roles, scope, identityProvider: 'cognito' });
const HHS_ADMIN = who(HHS_DEMO_TENANT, ['admin'], { kind: 'tenant' });
const HOUSTON_OPERATOR = who(HHS_DEMO_TENANT, ['operator'], { kind: 'site', siteId: 'hou-01' });

beforeEach(() => setRandom(seededRandom()));

test('every HHS site is a facility the comms config knows, and every facility has exactly one site', () => {
  const hhs = generateEstate(HHS_DEMO_TENANT);
  const known = Object.keys(COMMS_CONFIG[HHS_DEMO_TENANT].facilityNames ?? {}).sort();
  const sited = hhs.sites.map((s) => s.facility).filter((f): f is string => !!f).sort();
  // Compared against the CONFIG, not a copy of the layout: a facility added
  // to one side only shows up here as a mismatch, not as a quiet gap.
  assert.deepEqual(sited, known);
  assert.equal(new Set(sited).size, sited.length, 'one site per facility');
  assert.ok(hhs.sites.every((s) => s.facility), 'no HHS site without a facility');
});

test('Acme has no facilities - no join where the customer has no such scheme', () => {
  assert.ok(generateEstate('acme-networks').sites.every((s) => s.facility === undefined));
});

test('what the scenarios and the SolarWinds fixture rely on is still there', () => {
  const hhs = generateEstate(HHS_DEMO_TENANT);
  // IPs come from site order; Orion's HHS nodes resolve by 10.11.0.x.
  assert.equal(hhs.sites[0].siteId, 'dal-01');
  const core = hhs.devices.find((d) => d.deviceId === 'dev-cor-dal01-01');
  assert.ok(core?.aliases.some((a) => a.kind === 'mgmt-ip' && a.value === '10.11.0.1'));
  assert.equal(hhs.devices.filter((d) => d.siteId === 'dal-01').length, 16);
  for (const vendor of ['cisco', 'juniper', 'aruba'] as const) {
    assert.ok(hhs.devices.some((d) => d.vendor === vendor), 'the scenarios need a ' + vendor + ' device');
  }
  // Acme is untouched: the same five sites, the same sixty devices.
  const acme = generateEstate('acme-networks');
  assert.deepEqual(acme.sites.map((s) => s.siteId), ['dal-01', 'aus-01', 'den-01', 'chi-01', 'phx-01']);
  assert.equal(acme.devices.length, 60);
});

test('a facility\'s network, and a device\'s facility - both inside the caller\'s scope', () => {
  loadEstate(HHS_DEMO_TENANT, true);
  const houston = devicesAtFacility(HHS_ADMIN, '1120');
  assert.ok(houston.length > 0);
  assert.ok(houston.every((d) => d.siteId === 'hou-01'));
  assert.equal(facilityOfDevice(HHS_ADMIN, houston[0].deviceId), '1120');

  // A Houston operator sees Houston's network and nobody else's.
  assert.equal(devicesAtFacility(HOUSTON_OPERATOR, '1120').length, houston.length);
  assert.deepEqual(devicesAtFacility(HOUSTON_OPERATOR, '1455'), []);
  assert.equal(facilityOfDevice(HOUSTON_OPERATOR, 'dev-cor-dal01-01'), undefined, 'out of scope has no facility for them');

  // A facility with no network data is an empty answer, not an error.
  assert.deepEqual(devicesAtFacility(HHS_ADMIN, '9999'), []);
});
