/**
 * Multi-tenancy tests. If any of these ever fail, you have a data breach, not
 * a bug - which is why they exist as tests rather than as a code review habit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signDemoToken, verifyToken, TokenVerificationError } from '../auth/cognito-jwt-verifier.ts';
import {
  assertSameTenant, requireRole, CrossTenantAccessError, tenantScopedSessionPolicy,
  scopeAllowsDistrict, withinScope, OutOfScopeError, assertDistrictInScope,
} from './tenancy.ts';
import { putTelemetry, recentTelemetry } from './repository.ts';
import { handler as preTokenGeneration } from '../auth/pre-token-generation.ts';
import { resolveIdpForEmail } from '../auth/providers.ts';
import type { Driver, Principal, Telemetry } from './types.ts';

const acme = verifyToken(signDemoToken({
  sub: 'u1', email: 'a@acme.com', 'custom:tenantId': 'acme', 'cognito:groups': ['dispatcher'],
}));
const globex = verifyToken(signDemoToken({
  sub: 'u2', email: 'b@globex.com', 'custom:tenantId': 'globex', 'cognito:groups': ['viewer'],
}));

function reading(tenantId: string, id: string): Telemetry {
  return {
    tenantId, telemetryId: id, provider: 'samsara', domain: 'telematics', kind: 'harsh-brake',
    driverId: 'drv-1000', sourceRef: 'TRK-8891', value: 0.62, unit: 'g', severity: 'critical',
    observedAt: '2026-09-08T14:30:00.000Z', attributes: {},
  };
}

function driver(driverId: string, districtId: string): Driver {
  return {
    tenantId: 'acme', driverId, name: 'Test', districtId, vehicleId: 'V1',
    status: 'driving', lon: 0, lat: 0, hosRemainingMinutes: 300,
    updatedAt: '2026-09-08T14:30:00.000Z',
  };
}
test('a tenant cannot read another tenant telemetry', () => {
  putTelemetry(acme, [reading('acme', 'acme-1')]);
  putTelemetry(globex, [reading('globex', 'globex-1')]);
  const acmeSees = recentTelemetry(acme, 100).map((t) => t.telemetryId);
  const globexSees = recentTelemetry(globex, 100).map((t) => t.telemetryId);

  assert.ok(acmeSees.includes('acme-1'));
  assert.ok(!acmeSees.includes('globex-1'));
  assert.ok(globexSees.includes('globex-1'));
  assert.ok(!globexSees.includes('acme-1'));
});

test('assertSameTenant rejects a cross-tenant request', () => {
  assert.throws(() => assertSameTenant(globex, 'acme'), CrossTenantAccessError);
  assert.doesNotThrow(() => assertSameTenant(acme, 'acme'));
});

test('requireRole enforces write permissions', () => {
  assert.throws(() => requireRole(globex, 'admin', 'dispatcher'), /forbidden/);
  assert.doesNotThrow(() => requireRole(acme, 'admin', 'dispatcher'));
});

test('the IAM session policy pins dynamodb:LeadingKeys to one tenant', () => {
  const policy = tenantScopedSessionPolicy('acme', 'arn:aws:dynamodb:us-east-1:1:table/t');
  const keys = policy.Statement[0].Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];

  assert.deepEqual(keys, ['TENANT#acme#*']);
  // Not a bare wildcard - that would defeat the entire mechanism.
  assert.ok(!keys.includes('*'));
});

test('a token with a tampered tenant claim is rejected', () => {
  const token = signDemoToken({ sub: 'u1', 'custom:tenantId': 'acme' });
  const [header, payload, sig] = token.split('.');

  const forged = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
    'custom:tenantId': 'globex',
  })).toString('base64url');

  assert.throws(() => verifyToken([header, forged, sig].join('.')), TokenVerificationError);
});

test('an expired token is rejected', () => {
  const expired = signDemoToken({
    sub: 'u1', 'custom:tenantId': 'acme',
    exp: Math.floor(Date.now() / 1000) - 60,
  } as Parameters<typeof signDemoToken>[0]);

  assert.throws(() => verifyToken(expired), /expired/);
});

test('an id token is rejected where an access token is required', () => {
  const idToken = signDemoToken({
    sub: 'u1', 'custom:tenantId': 'acme', token_use: 'id',
  } as Parameters<typeof signDemoToken>[0]);

  assert.throws(() => verifyToken(idToken), /access token/);
});

test('a token with no tenant claim is rejected - fail closed', () => {
  const noTenant = signDemoToken({ sub: 'u1', 'custom:tenantId': '' });
  assert.throws(() => verifyToken(noTenant), /no tenant claim/);
});

test('unknown Cognito groups degrade to viewer, never to admin', () => {
  const weird = verifyToken(signDemoToken({
    sub: 'u3', 'custom:tenantId': 'acme',
    'cognito:groups': ['Adminstrators', 'superuser'],   // typo + made-up group
  }));

  assert.deepEqual(weird.roles, ['viewer']);
  const principal: Principal = weird;
  assert.throws(() => requireRole(principal, 'admin'));
});

// ---------------------------------------------------------------------------
// Scope: the second boundary, inside the tenant
// ---------------------------------------------------------------------------

test('a district-scoped dispatcher cannot see another district', () => {
  const dallas: Principal = { ...acme, scope: { kind: 'district', districtId: 'dal' } };

  assert.ok(scopeAllowsDistrict(dallas, 'dal'));
  assert.ok(!scopeAllowsDistrict(dallas, 'phx'));
  assert.throws(() => assertDistrictInScope(dallas, 'phx'), OutOfScopeError);
});

test('withinScope narrows a driver list to the caller\'s district', () => {
  const dallas: Principal = { ...acme, scope: { kind: 'district', districtId: 'dal' } };
  const fleet = [driver('drv-1', 'dal'), driver('drv-2', 'phx'), driver('drv-3', 'dal')];

  const visible = withinScope(dallas, fleet).map((d) => d.driverId);
  assert.deepEqual(visible, ['drv-1', 'drv-3']);
});

test('a driver-scoped principal sees only themselves', () => {
  const self: Principal = { ...acme, scope: { kind: 'driver', driverId: 'drv-2' } };
  const fleet = [driver('drv-1', 'dal'), driver('drv-2', 'phx')];

  assert.deepEqual(withinScope(self, fleet).map((d) => d.driverId), ['drv-2']);
  // A driver has no district board at all - not even their own district's.
  assert.ok(!scopeAllowsDistrict(self, 'phx'));
});

test('an admin is tenant-scoped, which is the only way to see everything', () => {
  const admin: Principal = { ...acme, scope: { kind: 'tenant' } };
  const fleet = [driver('drv-1', 'dal'), driver('drv-2', 'phx')];

  assert.equal(withinScope(admin, fleet).length, 2);
  assert.ok(scopeAllowsDistrict(admin, 'anything'));
});

// ---------------------------------------------------------------------------
// Where the scope comes from: the PreTokenGeneration trigger
// ---------------------------------------------------------------------------

test('the district is stamped into the token, not asserted by the client', async () => {
  const event = await preTokenGeneration({
    version: '1', triggerSource: 'TokenGeneration_Authentication',
    userPoolId: 'us-east-1_TEST', userName: 'd',
    request: {
      userAttributes: { email: 'dispatcher@acme-freight.com' },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] },
    },
    response: {},
  });

  const claims = event.response.claimsOverrideDetails?.claimsToAddOrOverride ?? {};
  assert.equal(claims['custom:tenantId'], 'acme-freight');
  // This is the whole point: the scope arrives SIGNED. A dispatcher cannot
  // widen their own board by editing a request, because the scope was never in
  // the request.
  assert.equal(claims['custom:district'], 'dal');
  assert.deepEqual(
    event.response.claimsOverrideDetails?.groupOverrideDetails?.groupsToOverride,
    ['dispatcher'],
  );
});

test('a device-bound driver token carries no district at all', async () => {
  const event = await preTokenGeneration({
    version: '1', triggerSource: 'TokenGeneration_Authentication',
    userPoolId: 'us-east-1_TEST', userName: 'drv',
    request: {
      userAttributes: { email: 'dispatcher@acme-freight.com', 'custom:deviceBound': 'true' },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] },
    },
    response: {},
  });

  const claims = event.response.claimsOverrideDetails?.claimsToAddOrOverride ?? {};
  // A driver sees their own assignments, not a board. Handing them a
  // district-scoped token would show them every other truck in Dallas.
  assert.equal(claims['custom:district'], undefined);
  assert.equal(claims['custom:tenantId'], 'acme-freight');
});

test('a V2 trigger writes the claims to the ACCESS token', async () => {
  // THE DEPLOYMENT BLOCKER, in a test.
  //
  // V1 reaches the id token only. This platform authorises on the access
  // token, so a pool wired to V1 signs people in and hands them a token with
  // no tenant claim - which the verifier then rejects, correctly, leaving a
  // failure that looks like broken verification rather than a mis-versioned
  // trigger. Terraform pins V2_0; this pins the shape it produces.
  const event = await preTokenGeneration({
    version: '2', triggerSource: 'TokenGeneration_HostedAuth',
    userPoolId: 'us-east-1_TEST', userName: 'd',
    request: {
      userAttributes: { email: 'dispatcher@acme-freight.com' },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] },
    },
    response: {},
  });

  const access = event.response.claimsAndScopeOverrideDetails?.accessTokenGeneration;
  assert.equal(access?.claimsToAddOrOverride?.['custom:tenantId'], 'acme-freight');
  assert.equal(access?.claimsToAddOrOverride?.['custom:district'], 'dal');
  assert.deepEqual(
    event.response.claimsAndScopeOverrideDetails?.groupOverrideDetails?.groupsToOverride,
    ['dispatcher'],
  );
  // And the V1 field stays empty, so nothing can read the old shape and
  // silently get undefined.
  assert.equal(event.response.claimsOverrideDetails, undefined);
});

test('an unknown domain gets no tenant - fail closed, not a guess', async () => {
  const event = await preTokenGeneration({
    version: '1', triggerSource: 'TokenGeneration_Authentication',
    userPoolId: 'us-east-1_TEST', userName: 'x',
    request: {
      userAttributes: { email: 'someone@unknown.example' },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] },
    },
    response: {},
  });

  const claims = event.response.claimsOverrideDetails?.claimsToAddOrOverride ?? {};
  assert.equal(claims['custom:tenantId'], '');
  // Every tenant-scoped query rejects an empty tenant, so the failure mode is
  // "sees nothing" rather than "guessed a tenant".
  assert.equal(claims['custom:onboarding'], 'pending');
});

test('home-realm discovery routes each carrier to its own IdP', () => {
  assert.equal(resolveIdpForEmail('a@acme-freight.com'), 'AcmeSAML');
  assert.equal(resolveIdpForEmail('b@northstar-logistics.com'), 'OktaOIDC');
  // An unknown domain falls back to the Cognito-native pool rather than
  // erroring - a new customer can sign up before their SSO is configured.
  assert.equal(resolveIdpForEmail('c@example.com'), 'COGNITO');
});
