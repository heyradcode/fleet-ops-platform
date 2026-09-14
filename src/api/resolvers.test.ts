/**
 * Resolver authorisation tests.
 *
 * Tenancy is the hard wall and is covered in platform/tenancy.test.ts. These
 * cover the SECOND boundary, inside the tenant: a Dallas operator has no
 * business reading Phoenix's board either, and the resolver is where that gets
 * enforced for anyone coming through the API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from './appsync-resolvers.ts';
import { subscribe, publishToSubscribers } from './subscriptions.ts';
import { setClock, fixedClock } from '../platform/clock.ts';
import { loadEstate } from '../geo/device-repository.ts';

setClock(fixedClock());
const estate = loadEstate('acme-networks');

/** An AppSync event, as the service would deliver it after verifying the JWT. */
function event(
  field: string,
  parent: 'Query' | 'Mutation',
  args: Record<string, unknown>,
  site?: string,
  groups: string[] = ['operator'],
) {
  return {
    info: { fieldName: field, parentTypeName: parent },
    arguments: args,
    identity: {
      sub: 'u1',
      claims: {
        email: 'd@acme-networks.com',
        'custom:tenantId': 'acme-networks',
        ...(site ? { 'custom:site': site } : {}),
      },
      groups,
    },
  };
}

test('a site-scoped operator sees only their own site', async () => {
  const dallas = await handler(event('devices', 'Query', {}, 'dal-01')) as Array<{ siteId: string }>;
  assert.ok(dallas.length > 0);
  assert.ok(dallas.every((d) => d.siteId === 'dal-01'));

  const phoenix = await handler(event('devices', 'Query', {}, 'phx-01')) as Array<{ siteId: string }>;
  assert.ok(phoenix.length > 0);
  assert.ok(phoenix.every((d) => d.siteId === 'phx-01'));
});

test('passing another site as an argument does not widen the board', async () => {
  // The argument is a convenience; the token is the boundary. An operator who
  // edits the request gets an empty list, not someone else's estate.
  const sneaky = await handler(event('devices', 'Query', { siteId: 'phx-01' }, 'dal-01')) as unknown[];
  assert.equal(sneaky.length, 0);
});

test('an admin with tenant scope sees the whole estate', async () => {
  const all = await handler(event('devices', 'Query', {}, undefined, ['admin'])) as unknown[];
  assert.equal(all.length, estate.devices.length);
});

test('fetching one device from another site returns null, not the device', async () => {
  const all = await handler(
    event('devices', 'Query', {}, undefined, ['admin']),
  ) as Array<{ deviceId: string; siteId: string }>;
  const phoenixDevice = all.find((d) => d.siteId === 'phx-01')!;

  const asDallas = await handler(
    event('device', 'Query', { deviceId: phoenixDevice.deviceId }, 'dal-01'),
  );
  assert.equal(asDallas, null);

  // ...and the same request from the right site succeeds, so the test is
  // proving a boundary rather than a broken lookup.
  const asPhoenix = await handler(
    event('device', 'Query', { deviceId: phoenixDevice.deviceId }, 'phx-01'),
  ) as { deviceId: string };
  assert.equal(asPhoenix.deviceId, phoenixDevice.deviceId);
});

test('publishAlarm pushes only to boards whose filter matches', async () => {
  const woken: string[] = [];
  for (const site of ['dal-01', 'phx-01', 'chi-01']) {
    subscribe('onDeviceAlarm', { siteId: site }, () => woken.push(site));
  }

  await handler(event('publishAlarm', 'Mutation', {
    input: {
      alarmId: 'alm_test', deviceId: 'dev-cor-dal01-01', siteId: 'dal-01',
      kind: 'link-down', severity: 'critical',
      planes: ['device', 'controller'], raisedAt: '2026-09-08T14:30:00.000Z',
    },
  }, 'dal-01'));

  // AppSync evaluates the filter BEFORE pushing. On a syslog-heavy estate this
  // is the difference between a bill proportional to incidents and one
  // proportional to estate size - and it keeps Dallas traffic out of Phoenix's
  // dev tools, which is a confidentiality property as much as a cost one.
  assert.deepEqual(woken, ['dal-01']);
});

test('a subscriber cannot receive a field the mutation did not return', () => {
  // The AppSync detail that surprises everyone once: the subscription payload
  // IS the mutation's return value. Filtering on a field that is not in it
  // silently matches nothing.
  const got: string[] = [];
  subscribe('onDeviceAlarm', { interfaceId: 'if-nope-1' }, () => got.push('matched'));

  publishToSubscribers('onDeviceAlarm', {
    alarmId: 'alm_x', siteId: 'dal-01', deviceId: 'dev-cor-dal01-01',
  });

  assert.equal(got.length, 0);
});
