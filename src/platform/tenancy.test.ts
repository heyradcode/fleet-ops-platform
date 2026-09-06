/**
 * Multi-tenancy tests. If any of these ever fail, you have a data breach, not
 * a bug - which is why they exist as tests rather than as a code review habit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signDemoToken, verifyToken, TokenVerificationError } from '../auth/cognito-jwt-verifier.ts';
import { assertSameTenant, requireRole, CrossTenantAccessError, tenantScopedSessionPolicy } from './tenancy.ts';
import { putSignals, recentSignals } from './repository.ts';
import type { Principal, Signal } from './types.ts';

const acme = verifyToken(signDemoToken({
  sub: 'u1', email: 'a@acme.com', 'custom:tenantId': 'acme', 'cognito:groups': ['operator'],
}));
const globex = verifyToken(signDemoToken({
  sub: 'u2', email: 'b@globex.com', 'custom:tenantId': 'globex', 'cognito:groups': ['viewer'],
}));

function signal(tenantId: string, id: string): Signal {
  return {
    tenantId, signalId: id, provider: 'splunk', domain: 'observability', kind: 'error-rate',
    siteId: 'dal-01', sourceRef: 'dal-01', value: 9, unit: 'percent', severity: 'critical',
    observedAt: '2026-09-04T10:00:00Z', attributes: {},
  };
}

test('a tenant cannot read another tenant\'s signals', () => {
  putSignals(acme, [signal('acme', 'acme-1')]);
  putSignals(globex, [signal('globex', 'globex-1')]);

  const acmeSees = recentSignals(acme, 100).map((s) => s.signalId);
  const globexSees = recentSignals(globex, 100).map((s) => s.signalId);

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
