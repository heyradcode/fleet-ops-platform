/**
 * The membership registry, and the reason it is a registry.
 *
 * The trigger handler is imported by the browser, so the DynamoDB client
 * cannot live inside it. These tests pin the two properties that shape
 * depends on: the default answers without any AWS at all, and an injected
 * lookup replaces it completely.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lookupTenantMembership, setMembershipLookup, resetMembershipLookup,
  membershipKey, DEMO_MEMBERSHIPS,
} from './membership.ts';
import { handler as preTokenGeneration } from '../auth/pre-token-generation.ts';

function event(email: string) {
  return {
    version: '2',
    triggerSource: 'TokenGeneration_HostedAuth' as const,
    userPoolId: 'us-east-1_TEST',
    userName: email,
    request: {
      userAttributes: { email },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] },
    },
    response: {},
  };
}

test('the default lookup needs no AWS, and answers from the built-in table', async () => {
  resetMembershipLookup();

  const dispatcher = await lookupTenantMembership('anyone@acme-freight.com');
  assert.equal(dispatcher?.tenantId, 'acme-freight');
  assert.equal(dispatcher?.district, 'dal');

  // This is what keeps `pnpm start`, the offline board and the rest of the
  // suite working with no credentials - and it is the whole argument for the
  // registry over a raw GetItem in the trigger.
  assert.equal(await lookupTenantMembership('nobody@gmail.com'), undefined);
});

test('the key is the email domain, lowercased', () => {
  assert.equal(membershipKey('Dispatcher@Acme-Freight.COM'), 'acme-freight.com');
  assert.equal(membershipKey('not-an-email'), '');
});

test('an injected lookup replaces the built-in table entirely', async () => {
  setMembershipLookup(async (email) =>
    email === 'someone@newco.example'
      ? { tenantId: 'newco', roles: ['viewer'], district: 'phx' }
      : undefined);

  try {
    // A carrier the built-in table has never heard of now resolves - which is
    // the point of moving membership into data.
    const added = await lookupTenantMembership('someone@newco.example');
    assert.equal(added?.tenantId, 'newco');

    // And one it DOES know no longer does, because the adapter is the only
    // source. A lookup that quietly fell back would hide a broken table.
    assert.equal(await lookupTenantMembership('a@acme-freight.com'), undefined);
  } finally {
    resetMembershipLookup();
  }
});

test('the trigger reads through the registry, so a table change reaches the token', async () => {
  setMembershipLookup(async () => ({ tenantId: 'newco', roles: ['admin'], district: 'phx' }));

  try {
    const out = await preTokenGeneration(event('whoever@newco.example'));
    const claims = out.response.claimsAndScopeOverrideDetails?.accessTokenGeneration
      ?.claimsToAddOrOverride;

    assert.equal(claims?.['custom:tenantId'], 'newco');
    assert.equal(claims?.['custom:district'], 'phx');
  } finally {
    resetMembershipLookup();
  }
});

test('the seed rows Terraform writes match the built-in table', () => {
  // Two hand-maintained copies of the same four carriers WILL drift - a tenant
  // rename has caught this repository out once already. Terraform seeds from
  // the shape this constant documents; if someone edits one, this fails.
  assert.deepEqual(Object.keys(DEMO_MEMBERSHIPS).sort(), [
    'acme-freight.com',
    'meridian.io',
    'northstar-logistics.com',
    'safety.acme-freight.com',
  ]);
  assert.equal(DEMO_MEMBERSHIPS['acme-freight.com'].district, 'dal');
  assert.equal(DEMO_MEMBERSHIPS['meridian.io'].district, undefined);
});
