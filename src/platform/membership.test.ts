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
import { readFileSync } from 'node:fs';

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

  const operator = await lookupTenantMembership('anyone@acme-networks.com');
  assert.equal(operator?.tenantId, 'acme-networks');
  assert.equal(operator?.site, 'dal-01');

  // This is what keeps `pnpm start`, the offline board and the rest of the
  // suite working with no credentials - and it is the whole argument for the
  // registry over a raw GetItem in the trigger.
  assert.equal(await lookupTenantMembership('nobody@gmail.com'), undefined);
});

test('the key is the email domain, lowercased', () => {
  assert.equal(membershipKey('Operator@Acme-Networks.COM'), 'acme-networks.com');
  assert.equal(membershipKey('not-an-email'), '');
});

test('an injected lookup replaces the built-in table entirely', async () => {
  setMembershipLookup(async (email) =>
    email === 'someone@newco.example'
      ? { tenantId: 'newco', roles: ['viewer'], site: 'phx' }
      : undefined);

  try {
    // A customer the built-in table has never heard of now resolves - which is
    // the point of moving membership into data.
    const added = await lookupTenantMembership('someone@newco.example');
    assert.equal(added?.tenantId, 'newco');

    // And one it DOES know no longer does, because the adapter is the only
    // source. A lookup that quietly fell back would hide a broken table.
    assert.equal(await lookupTenantMembership('a@acme-networks.com'), undefined);
  } finally {
    resetMembershipLookup();
  }
});

test('the trigger reads through the registry, so a table change reaches the token', async () => {
  setMembershipLookup(async () => ({ tenantId: 'newco', roles: ['admin'], site: 'phx' }));

  try {
    const out = await preTokenGeneration(event('whoever@newco.example'));
    const claims = out.response.claimsAndScopeOverrideDetails?.accessTokenGeneration
      ?.claimsToAddOrOverride;

    assert.equal(claims?.['custom:tenantId'], 'newco');
    assert.equal(claims?.['custom:site'], 'phx');
  } finally {
    resetMembershipLookup();
  }
});

test('the seed rows Terraform writes match the built-in table', () => {
  // Two hand-maintained copies of the same five customers WILL drift - a tenant
  // rename has caught this repository out once already.
  //
  // THIS TEST USED TO BE GREEN FOR THE WRONG REASON. It re-asserted the
  // TypeScript constant against a hardcoded list and never opened the .tf at
  // all, so when the port left `safety.acme-networks.com` with a `safety`
  // role and a site of "dal" behind in Terraform, nothing failed. That is the
  // documented gotcha about non-TypeScript files being invisible to every
  // check, landing on the one test written to prevent it. Parse the HCL.
  const tf = readFileSync(
    new URL('../../infra/terraform/auth/membership.tf', import.meta.url), 'utf8',
  );

  // The locals block alone, not the whole file - PK prefixes elsewhere mention
  // domains too, and matching those would make this pass on the wrong text.
  //
  // These rows are seeded only when var.seed_demo_customers is on, which a
  // real deployment leaves off. They are still worth pinning: the flag decides
  // whether they are WRITTEN, not whether they are right, and a demo customer
  // that disagrees with the offline board is the same drift in a quieter place.
  const forEach = tf.slice(
    tf.indexOf('demo_customers = {'),
    tf.indexOf('resource "aws_dynamodb_table_item"'),
  );

  // Line-oriented rather than one big regex: HCL formatting is not stable
  // across `terraform fmt` versions, and a regex that stops matching after a
  // reformat fails OPEN - it parses nothing and every assertion below passes
  // vacuously. Hence the size check.
  const seeded = new Map<string, { roles: string[]; site?: string }>();
  let domain = '';
  for (const raw of forEach.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('"') && line.endsWith('= {')) {
      domain = line.slice(1, line.indexOf('"', 1));
      seeded.set(domain, { roles: [] });
      continue;
    }
    const eq = line.indexOf('=');
    if (!domain || eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'roles') {
      seeded.get(domain)!.roles = value.slice(1, -1).split(',')
        .map((r) => r.trim().split('"').join(''))
        .filter((r) => r.length > 0);
    } else if (key === 'site' && value !== 'null') {
      seeded.get(domain)!.site = value.slice(1, -1);
    }
  }

  // A parse that matched nothing would make every assertion below vacuous.
  assert.equal(seeded.size, 5, 'the for_each block did not parse - fix this test, not the .tf');
  assert.deepEqual([...seeded.keys()].sort(), Object.keys(DEMO_MEMBERSHIPS).sort());

  for (const [domain, built] of Object.entries(DEMO_MEMBERSHIPS)) {
    const row = seeded.get(domain)!;
    assert.deepEqual(row.roles, built.roles, domain + ': roles disagree');
    assert.equal(row.site, built.site, domain + ': site disagrees');
    // `safety` was not in this union, so mapGroupsToRoles dropped it and the
    // deployed engineer silently became a viewer. A role Terraform writes that
    // the verifier will not accept is worse than no role at all.
    for (const r of row.roles) {
      assert.ok(['admin', 'operator', 'engineer', 'viewer'].includes(r),
        domain + ': "' + r + '" is not a role the JWT verifier maps');
    }
  }
});
