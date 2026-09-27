/**
 * Real-pool tokens: RS256 against a published JWKS - and checked against REAL
 * time, whatever the demo clock says.
 *
 * These did not exist, which is how a real token came to be judged against
 * the demo's pinned 8 September: every request after the first in a warm
 * container was "issued in the future", and an expired token could never
 * expire. A real RSA key pair signs real tokens here; the JWKS is served from
 * a stubbed fetch.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, systemClock, wallNow } from '../platform/clock.ts';
import { b64urlEncode } from '../platform/crypto.ts';
import { verifyTokenRs256, TokenVerificationError } from './cognito-jwt-verifier.ts';

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL';
const CLIENT = 'test-client';
const KID = 'test-kid-1';

let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
const realFetch = globalThis.fetch;

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as { publicKey: CryptoKey; privateKey: CryptoKey };
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as unknown as Record<string, unknown>;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) !== ISSUER + '/.well-known/jwks.json') throw new Error('unexpected fetch ' + String(input));
    return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] }));
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; setClock(systemClock()); });

// The world as the board API and the agent leave it: pinned to the demo date.
beforeEach(() => setClock(fixedClock()));

const text = (s: string) => new TextEncoder().encode(s);

async function sign(claims: Record<string, unknown>): Promise<string> {
  const head = b64urlEncode(text(JSON.stringify({ alg: 'RS256', kid: KID })));
  const body = b64urlEncode(text(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, text(head + '.' + body)));
  return head + '.' + body + '.' + b64urlEncode(sig);
}

const realClaims = (overrides: Record<string, unknown> = {}) => {
  const t = Math.floor(wallNow() / 1000);
  return {
    iss: ISSUER, client_id: CLIENT, token_use: 'access', sub: 'u1',
    iat: t, exp: t + 3600, 'custom:tenantId': 'hhs-demo', 'cognito:groups': ['admin'],
    ...overrides,
  };
};

test('a token issued NOW verifies, even while the demo clock is pinned to 8 September', async () => {
  const principal = await verifyTokenRs256(await sign(realClaims()), { issuer: ISSUER, clientId: CLIENT });
  assert.equal(principal.tenantId, 'hhs-demo');
});

test('a token that expired in REAL time is refused - the pinned clock cannot keep it alive', async () => {
  const t = Math.floor(wallNow() / 1000);
  const stale = await sign(realClaims({ iat: t - 7200, exp: t - 3600 }));
  await assert.rejects(verifyTokenRs256(stale, { issuer: ISSUER, clientId: CLIENT }),
    (e: unknown) => e instanceof TokenVerificationError && /expired/.test(e.message));
});

test('the other checks still hold for a real token: signature, issuer, client, token_use, tenant', async () => {
  const pool = { issuer: ISSUER, clientId: CLIENT };
  const good = await sign(realClaims());
  const tampered = good.split('.').slice(0, 2).join('.') + '.' + b64urlEncode(new Uint8Array(256));
  // Thunks, awaited one at a time: a promise started early and awaited late
  // rejects with nobody listening.
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['bad signature', () => verifyTokenRs256(tampered, pool)],
    ['wrong issuer', async () => verifyTokenRs256(await sign(realClaims({ iss: ISSUER + 'x' })), pool)],
    ['wrong client', async () => verifyTokenRs256(await sign(realClaims({ client_id: 'someone-else' })), pool)],
    ['id token', async () => verifyTokenRs256(await sign(realClaims({ token_use: 'id' })), pool)],
    ['no tenant', async () => verifyTokenRs256(await sign(realClaims({ 'custom:tenantId': '' })), pool)],
  ];
  for (const [why, attempt] of cases) await assert.rejects(attempt, TokenVerificationError, why);
});
