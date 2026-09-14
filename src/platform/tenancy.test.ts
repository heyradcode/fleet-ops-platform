/**
 * Multi-tenancy tests. If any of these ever fail, you have a data breach, not
 * a bug - which is why they exist as tests rather than as a code review habit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signDemoToken, verifyToken, TokenVerificationError } from '../auth/cognito-jwt-verifier.ts';
import {
  assertSameTenant, requireRole, CrossTenantAccessError, tenantScopedSessionPolicy,
  scopeAllowsSite, withinScope, OutOfScopeError, assertSiteInScope,
} from './tenancy.ts';
import { putObservations, recentObservations } from './repository.ts';
import { handler as preTokenGeneration } from '../auth/pre-token-generation.ts';
import { resolveIdpForEmail } from '../auth/providers.ts';
import type { DeviceState, Principal, Observation } from './types.ts';

const acme = verifyToken(signDemoToken({
  sub: 'u1', email: 'a@acme.com', 'custom:tenantId': 'acme', 'cognito:groups': ['operator'],
}));
const globex = verifyToken(signDemoToken({
  sub: 'u2', email: 'b@globex.com', 'custom:tenantId': 'globex', 'cognito:groups': ['viewer'],
}));

function reading(tenantId: string, id: string): Observation {
  return {
    tenantId, observationId: id,
    vendor: 'cisco', platform: 'ios-xe', encoding: 'syslog', plane: 'device',
    deviceId: 'dev-cor-dal01-01', sourceRef: 'GigabitEthernet1/0/1',
    observedAt: '2026-09-08T14:30:00.000Z', receivedAt: '2026-09-08T14:30:00.000Z',
    severity: 'critical', attributes: {},
    class: 'event', kind: 'link-state', state: 'down', message: 'link down', dedupeKey: 'k-' + id,
  };
}

function device(deviceId: string, siteId: string): DeviceState {
  return {
    tenantId: 'acme', deviceId, name: deviceId, siteId,
    role: 'access', vendor: 'cisco', status: 'healthy',
    lon: 0, lat: 0, cpuUtilisation: 10, interfacesDown: 0,
    updatedAt: '2026-09-08T14:30:00.000Z',
  };
}
test('a tenant cannot read another tenant observations', () => {
  putObservations(acme, [reading('acme', 'acme-1')]);
  putObservations(globex, [reading('globex', 'globex-1')]);
  const acmeSees = recentObservations(acme, 100).map((t) => t.observationId);
  const globexSees = recentObservations(globex, 100).map((t) => t.observationId);

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
  assert.throws(() => requireRole(globex, 'admin', 'operator'), /forbidden/);
  assert.doesNotThrow(() => requireRole(acme, 'admin', 'operator'));
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

test('a site-scoped operator cannot see another site', () => {
  const dallas: Principal = { ...acme, scope: { kind: 'site', siteId: 'dal-01' } };

  assert.ok(scopeAllowsSite(dallas, 'dal-01'));
  assert.ok(!scopeAllowsSite(dallas, 'phx-01'));
  assert.throws(() => assertSiteInScope(dallas, 'phx-01'), OutOfScopeError);
});

test('withinScope narrows a driver list to the caller\'s district', () => {
  const dallas: Principal = { ...acme, scope: { kind: 'site', siteId: 'dal-01' } };
  const fleet = [device('dev-1', 'dal-01'), device('dev-2', 'phx-01'), device('dev-3', 'dal-01')];

  const visible = withinScope(dallas, fleet).map((d) => d.deviceId);
  assert.deepEqual(visible, ['dev-1', 'dev-3']);
});

test('a device-scoped principal sees only that device', () => {
  const self: Principal = { ...acme, scope: { kind: 'device', deviceId: 'dev-2' } };
  const fleet = [device('dev-1', 'dal-01'), device('dev-2', 'phx-01')];

  assert.deepEqual(withinScope(self, fleet).map((d) => d.deviceId), ['dev-2']);
  // A driver has no district board at all - not even their own district's.
  assert.ok(!scopeAllowsSite(self, 'phx-01'));
});

test('an admin is tenant-scoped, which is the only way to see everything', () => {
  const admin: Principal = { ...acme, scope: { kind: 'tenant' } };
  const fleet = [device('dev-1', 'dal-01'), device('dev-2', 'phx-01')];

  assert.equal(withinScope(admin, fleet).length, 2);
  assert.ok(scopeAllowsSite(admin, 'anything'));
});

// ---------------------------------------------------------------------------
// Where the scope comes from: the PreTokenGeneration trigger
// ---------------------------------------------------------------------------

test('the site is stamped into the token, not asserted by the client', async () => {
  const event = await preTokenGeneration({
    version: '1', triggerSource: 'TokenGeneration_Authentication',
    userPoolId: 'us-east-1_TEST', userName: 'd',
    request: {
      userAttributes: { email: 'operator@acme-networks.com' },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] },
    },
    response: {},
  });

  const claims = event.response.claimsOverrideDetails?.claimsToAddOrOverride ?? {};
  assert.equal(claims['custom:tenantId'], 'acme-networks');
  // This is the whole point: the scope arrives SIGNED. An operator cannot
  // widen their own board by editing a request, because the scope was never in
  // the request.
  assert.equal(claims['custom:site'], 'dal-01');
  assert.deepEqual(
    event.response.claimsOverrideDetails?.groupOverrideDetails?.groupsToOverride,
    ['operator'],
  );
});

test('a device-bound token carries no site claim at all', async () => {
  const event = await preTokenGeneration({
    version: '1', triggerSource: 'TokenGeneration_Authentication',
    userPoolId: 'us-east-1_TEST', userName: 'drv',
    request: {
      userAttributes: { email: 'operator@acme-networks.com', 'custom:deviceBound': 'true' },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] },
    },
    response: {},
  });

  const claims = event.response.claimsOverrideDetails?.claimsToAddOrOverride ?? {};
  // A driver sees their own assignments, not a board. Handing them a
  // district-scoped token would show them every other truck in Dallas.
  assert.equal(claims['custom:site'], undefined);
  assert.equal(claims['custom:tenantId'], 'acme-networks');
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
      userAttributes: { email: 'operator@acme-networks.com' },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] },
    },
    response: {},
  });

  const access = event.response.claimsAndScopeOverrideDetails?.accessTokenGeneration;
  assert.equal(access?.claimsToAddOrOverride?.['custom:tenantId'], 'acme-networks');
  assert.equal(access?.claimsToAddOrOverride?.['custom:site'], 'dal-01');
  assert.deepEqual(
    event.response.claimsAndScopeOverrideDetails?.groupOverrideDetails?.groupsToOverride,
    ['operator'],
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

test('home-realm discovery routes each customer to its own IdP', () => {
  assert.equal(resolveIdpForEmail('a@acme-networks.com'), 'AcmeSAML');
  assert.equal(resolveIdpForEmail('b@northwind-utilities.com'), 'OktaOIDC');
  // An unknown domain falls back to the Cognito-native pool rather than
  // erroring - a new customer can sign up before their SSO is configured.
  assert.equal(resolveIdpForEmail('c@example.com'), 'COGNITO');
});
