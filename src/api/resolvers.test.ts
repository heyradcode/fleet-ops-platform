/**
 * Resolver authorisation tests.
 *
 * Tenancy is the hard wall and is covered in platform/tenancy.test.ts. These
 * cover the SECOND boundary, inside the tenant: a Dallas dispatcher has no
 * business reading Phoenix's board either, and the resolver is where that gets
 * enforced for anyone coming through the API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from './appsync-resolvers.ts';
import { subscribe, publishToSubscribers } from './subscriptions.ts';
import { setClock, fixedClock } from '../platform/clock.ts';

setClock(fixedClock());

/** An AppSync event, as the service would deliver it after verifying the JWT. */
function event(field: string, parent: 'Query' | 'Mutation', args: Record<string, unknown>, district?: string) {
  return {
    info: { fieldName: field, parentTypeName: parent },
    arguments: args,
    identity: {
      sub: 'u1',
      claims: {
        email: 'd@acme-freight.com',
        'custom:tenantId': 'acme-freight',
        ...(district ? { 'custom:district': district } : {}),
      },
      groups: ['dispatcher'],
    },
  };
}

test('a district-scoped dispatcher sees only their own drivers', async () => {
  const dallas = await handler(event('drivers', 'Query', {}, 'dal')) as Array<{ districtId: string }>;
  assert.ok(dallas.length > 0);
  assert.ok(dallas.every((d) => d.districtId === 'dal'));

  const phoenix = await handler(event('drivers', 'Query', {}, 'phx')) as Array<{ districtId: string }>;
  assert.ok(phoenix.every((d) => d.districtId === 'phx'));

  // Different boards, no overlap.
  assert.notEqual(dallas.length, 0);
  assert.notEqual(phoenix.length, 0);
});

test('passing another district as an argument does not widen the board', async () => {
  // The argument is a convenience; the token is the boundary. A dispatcher who
  // edits the request gets an empty list, not someone else's fleet.
  const sneaky = await handler(event('drivers', 'Query', { districtId: 'phx' }, 'dal')) as unknown[];
  assert.equal(sneaky.length, 0);
});

test('an admin with tenant scope sees the whole fleet', async () => {
  const all = await handler(event('drivers', 'Query', {})) as unknown[];
  assert.equal(all.length, 60);
});

test('fetching one driver from another district returns null, not the driver', async () => {
  const all = await handler(event('drivers', 'Query', {})) as Array<{ driverId: string; districtId: string }>;
  const phoenixDriver = all.find((d) => d.districtId === 'phx')!;

  const asDallas = await handler(
    event('driver', 'Query', { driverId: phoenixDriver.driverId }, 'dal'),
  );
  assert.equal(asDallas, null);

  // ...and the same request from the right district succeeds, so the test is
  // proving a boundary rather than a broken lookup.
  const asPhoenix = await handler(
    event('driver', 'Query', { driverId: phoenixDriver.driverId }, 'phx'),
  ) as { driverId: string };
  assert.equal(asPhoenix.driverId, phoenixDriver.driverId);
});

test('publishException pushes only to boards whose filter matches', async () => {
  const woken: string[] = [];
  for (const district of ['dal', 'phx', 'chi']) {
    subscribe('onDriverException', { districtId: district }, () => woken.push(district));
  }

  await handler(event('publishException', 'Mutation', {
    input: {
      exceptionId: 'exc_test', driverId: 'drv-1000', districtId: 'dal',
      kind: 'route-deviation', severity: 'critical',
      providers: ['samsara'], raisedAt: '2026-09-08T14:30:00.000Z',
    },
  }, 'dal'));

  // AppSync evaluates the filter BEFORE pushing. At 11,000 readings/sec this
  // is the difference between a bill proportional to incidents and one
  // proportional to fleet size - and it keeps Dallas traffic out of Phoenix's
  // dev tools, which is a confidentiality property as much as a cost one.
  assert.deepEqual(woken, ['dal']);
});

test('a subscriber cannot receive a field the mutation did not return', () => {
  // The AppSync detail that surprises everyone once: the subscription payload
  // IS the mutation's return value. Filtering on a field that is not in it
  // silently matches nothing.
  const got: string[] = [];
  subscribe('onDriverException', { vehicleId: 'TRK-8000' }, () => got.push('matched'));

  publishToSubscribers('onDriverException', {
    exceptionId: 'exc_x', districtId: 'dal', driverId: 'drv-1000',
  });

  assert.equal(got.length, 0);
});
