/**
 * ---------------------------------------------------------------------------
 * Cognito JWT verification
 * ---------------------------------------------------------------------------
 * In production you would not hand-roll this - use `aws-jwt-verify`:
 *
 *   import { CognitoJwtVerifier } from 'aws-jwt-verify';
 *   const verifier = CognitoJwtVerifier.create({
 *     userPoolId: process.env.COGNITO_USER_POOL_ID!,
 *     tokenUse: 'access',                       // or 'id'
 *     clientId: process.env.COGNITO_APP_CLIENT_ID!,
 *   });
 *   const payload = await verifier.verify(token);   // throws if invalid
 *
 * It is implemented here anyway, because "what does verifying a JWT actually
 * check?" is asked constantly and "the library does it" is not an answer.
 *
 * THE SEVEN CHECKS:
 *   1. Signature - Cognito signs with RS256. Fetch the public keys from
 *      https://cognito-idp.{region}.amazonaws.com/{poolId}/.well-known/jwks.json
 *      and pick the one whose `kid` matches the token header. CACHE the JWKS -
 *      fetching it per request adds latency and can get you throttled.
 *   2. `iss`  - must be your user pool. Otherwise any Cognito pool on earth
 *      can mint tokens your API accepts.
 *   3. `aud` (id token) or `client_id` (access token) - must be your app client.
 *   4. `token_use` - 'access' or 'id'. They are NOT interchangeable: only the
 *      id token carries user attributes like email.
 *   5. `exp` - not expired.
 *   6. `nbf` / `iat` - not from the future (allow a little clock skew).
 *   7. `alg` - must be RS256. Reject `none` and reject HS256 on an RS256 pool:
 *      accepting the token's own `alg` is the classic JWT confusion attack.
 *
 * ID TOKEN vs ACCESS TOKEN, in one line each:
 *   id token     - "who the user is". Claims/attributes. For your app.
 *   access token - "what they may do". Scopes and groups. For your API.
 *
 * TWO VERIFIERS LIVE HERE, and they share every check but the first.
 *
 *   verifyToken()       sync, HS256, against the demo issuer. No user pool, so
 *                       the board runs offline and the tests stay synchronous.
 *   verifyTokenRs256()  async, RS256, against a real pool's published JWKS.
 *                       Async because WebCrypto is - which is the whole reason
 *                       AuthProvider.restore() returns a promise.
 *
 * Checks 2-7 are one function called by both. If they ever forked, the offline
 * board would be demonstrating rules the deployed one does not apply, which is
 * a worse failure than either being wrong on its own.
 */
import { b64urlDecode, b64urlDecodeText, b64urlEncode, hmacSha256, timingSafeEqual } from '../platform/crypto.ts';
import type { Principal, TenantId } from '../platform/types.ts';
import { env } from '../platform/env.ts';
import { now as clockNow } from '../platform/clock.ts';

const DEMO_SECRET = 'demo-only-not-a-real-signing-key';
const ISSUER = env('COGNITO_ISSUER', 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123DEF');
const CLIENT_ID = env('COGNITO_APP_CLIENT_ID', '1h57kf5cpq17m0eml12EXAMPLE');

/** The claims Cognito puts in an access token, plus our custom ones. */
export type CognitoClaims = {
  sub: string;
  iss: string;
  client_id: string;
  token_use: 'access' | 'id';
  exp: number;
  iat: number;
  email: string;
  'cognito:groups': string[];
  /** Custom attributes are prefixed `custom:` and are how tenancy travels. */
  'custom:tenantId': TenantId;
  /** The dispatcher's district. Signed by Cognito, so it cannot be widened. */
  'custom:district'?: string;
  /** Which IdP the user federated from. Cognito sets this for federated users. */
  identities?: Array<{ providerName: string; userId: string }>;
};

export class TokenVerificationError extends Error {
  constructor(reason: string) {
    super('JWT rejected: ' + reason);
    this.name = 'TokenVerificationError';
  }
}

const b64url = b64urlEncode;

const unb64url = b64urlDecode;

/** Demo-only token minting. Cognito does this for you at the hosted UI. */
export function signDemoToken(claims: Partial<CognitoClaims> & { sub: string }): string {
  // The injected clock, not Date.now(). Both sides of this file read it, so
  // a demo running on a fixed clock mints tokens that same clock accepts.
  const now = Math.floor(clockNow() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: 'demo-key-1' };
  const payload: CognitoClaims = {
    iss: ISSUER,
    client_id: CLIENT_ID,
    token_use: 'access',
    iat: now,
    exp: now + 3600,
    email: 'user@example.com',
    'cognito:groups': ['viewer'],
    'custom:tenantId': 'acme',
    ...claims,
  } as CognitoClaims;

  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = b64url(hmacSha256(DEMO_SECRET, signingInput));
  return signingInput + '.' + sig;
}

/**
 * Verify and decode. Returns a `Principal` - a token is not an identity until
 * it has been checked, so the rest of the codebase only ever sees Principal.
 */
/** Split a JWS into its parts, trusting none of them yet. */
function split(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenVerificationError('not a three-part JWS');

  const [headerB64, payloadB64, sigB64] = parts;
  return {
    headerB64, payloadB64, sigB64,
    header: JSON.parse(b64urlDecodeText(headerB64)) as { alg: string; kid?: string },
    claims: JSON.parse(b64urlDecodeText(payloadB64)) as CognitoClaims,
  };
}

/** Checks 2-6 and the tenant claim, then the Principal. Shared by both paths. */
function principalFrom(claims: CognitoClaims, issuer: string, clientId: string): Principal {
  const now = Math.floor(clockNow() / 1000);

  if (claims.iss !== issuer) throw new TokenVerificationError('wrong issuer');                    // 2
  if (claims.client_id !== clientId) throw new TokenVerificationError('wrong client_id');         // 3
  if (claims.token_use !== 'access') throw new TokenVerificationError('expected an access token');// 4
  if (claims.exp <= now) throw new TokenVerificationError('expired');                             // 5
  if (claims.iat > now + 60) throw new TokenVerificationError('issued in the future');            // 6
  if (!claims['custom:tenantId']) throw new TokenVerificationError('no tenant claim');

  return {
    sub: claims.sub,
    email: claims.email,
    tenantId: claims['custom:tenantId'],
    roles: mapGroupsToRoles(claims['cognito:groups'] ?? []),
    scope: scopeFromClaims(claims),
    identityProvider: providerFromIdentities(claims.identities),
  };
}

export function verifyToken(token: string): Principal {
  const { headerB64, payloadB64, sigB64, header, claims } = split(token);

  // Check 7 first: never trust the token to tell you how to check the token.
  if (header.alg !== 'HS256') throw new TokenVerificationError('unexpected alg ' + header.alg);

  // Check 1: signature. timingSafeEqual, not ===, to avoid a timing oracle.
  const expected = hmacSha256(DEMO_SECRET, headerB64 + '.' + payloadB64);
  const actual = unb64url(sigB64);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new TokenVerificationError('signature mismatch');
  }

  return principalFrom(claims, ISSUER, CLIENT_ID);
}

// ---------------------------------------------------------------------------
// A real user pool: RS256 against the published JWKS
// ---------------------------------------------------------------------------

export type PoolConfig = {
  /** `https://cognito-idp.{region}.amazonaws.com/{userPoolId}` */
  issuer: string;
  clientId: string;
};

/**
 * The subset of a JWK we accept.
 *
 * Declared rather than imported: `JsonWebKey` is a DOM type, this file is in
 * the graph the backend compiles without DOM, and one shared file cannot
 * depend on a lib only half its consumers have.
 */
type Jwk = { kid: string; alg: string; kty: string; n: string; e: string };

/**
 * A view whose buffer is definitely an ArrayBuffer.
 *
 * WebCrypto's types reject a plain Uint8Array because it MIGHT be backed by a
 * SharedArrayBuffer, which cannot be handed to crypto. Copying is the honest
 * fix - the same one platform/crypto.ts already makes - and a signature is
 * 256 bytes, so the copy costs nothing.
 */
function asBuffer(from: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(from.length));
  out.set(from);
  return out;
}

/**
 * Imported keys, cached for the life of the page or the Lambda container.
 *
 * Cognito publishes two keys and rotates rarely, so caching by `kid` is safe;
 * fetching per request adds a round trip to every call and eventually earns a
 * throttle. A `kid` that misses re-fetches once - that is the rotation path,
 * and it is why the miss is a cache refill rather than an error.
 */
const jwksCache = new Map<string, Map<string, CryptoKey>>();

async function keyFor(issuer: string, kid: string): Promise<CryptoKey> {
  let keys = jwksCache.get(issuer);

  if (!keys?.has(kid)) {
    const res = await fetch(issuer + '/.well-known/jwks.json');
    if (!res.ok) throw new TokenVerificationError('could not fetch the pool JWKS');
    const body = await res.json() as { keys: Jwk[] };

    keys = new Map();
    for (const jwk of body.keys) {
      // Import only what we will accept. A pool that started publishing
      // something else must not have it silently imported and trusted.
      if (jwk.alg !== 'RS256') continue;
      keys.set(jwk.kid, await crypto.subtle.importKey(
        'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
      ));
    }
    jwksCache.set(issuer, keys);
  }

  const key = keys.get(kid);
  if (!key) throw new TokenVerificationError('no published key matches kid ' + kid);
  return key;
}

/**
 * The same seven checks, against a deployed pool.
 *
 * `crypto.subtle` is the one cryptography API that exists unchanged in Node
 * and in a browser, so this stays in the shared module graph like everything
 * else - no `node:crypto`, and the board can verify its own token.
 */
export async function verifyTokenRs256(token: string, pool: PoolConfig): Promise<Principal> {
  const { headerB64, payloadB64, sigB64, header, claims } = split(token);

  // Check 7, and it carries more weight here than in the demo path. Accepting
  // the token's own `alg` is the JWT confusion attack, and against a pool whose
  // verification key is PUBLISHED, an attacker allowed to pick HS256 can sign
  // their own tokens with that public key as the HMAC secret.
  if (header.alg !== 'RS256') throw new TokenVerificationError('unexpected alg ' + header.alg);
  if (!header.kid) throw new TokenVerificationError('no kid in the header');

  const key = await keyFor(pool.issuer, header.kid);
  const signed = asBuffer(new TextEncoder().encode(headerB64 + '.' + payloadB64));
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, asBuffer(unb64url(sigB64)), signed,
  );
  if (!ok) throw new TokenVerificationError('signature mismatch');

  return principalFrom(claims, pool.issuer, pool.clientId);
}

/**
 * Cognito groups are strings; our code wants a closed union. Mapping here means
 * a typo in the Cognito console degrades to "no role" rather than crashing, and
 * an unexpected group can never silently become an admin.
 */
function mapGroupsToRoles(groups: string[]): Principal['roles'] {
  const valid: Principal['roles'] = [];
  for (const g of groups) {
    if (g === 'admin' || g === 'dispatcher' || g === 'safety' ||
        g === 'driver' || g === 'viewer') valid.push(g);
  }
  return valid.length > 0 ? valid : ['viewer'];
}

/**
 * Derive the caller's scope from their claims.
 *
 * Cognito stamps `custom:district` in the PreTokenGeneration trigger, so the
 * scope arrives already signed - a dispatcher cannot widen their own board by
 * editing a request. Absence of a district is NOT treated as "see everything":
 * only an explicit admin role gets tenant-wide scope, and everyone else falls
 * back to the narrowest thing that still makes sense.
 */
function scopeFromClaims(claims: CognitoClaims): Principal['scope'] {
  const roles = mapGroupsToRoles(claims['cognito:groups'] ?? []);

  // SCOPE IS NOT PERMISSION, and conflating them is how safety teams end up
  // unable to do their job. A safety reviewer has to read the whole carrier -
  // a harsh-braking pattern is only visible across districts - but must not be
  // able to move a load. Scope answers "what may they SEE"; requireRole() and
  // canUseTool() answer "what may they DO", and they answer it separately.
  if (roles.includes('admin') || roles.includes('safety')) return { kind: 'tenant' };

  const district = claims['custom:district'];
  if (district) return { kind: 'district', districtId: district };

  // A driver with no district claim sees their own assignments and nothing else.
  return { kind: 'driver', driverId: claims.sub };
}

function providerFromIdentities(identities: CognitoClaims['identities']): Principal['identityProvider'] {
  const name = identities?.[0]?.providerName;
  switch (name) {
    case 'Google': return 'Google';
    case 'Facebook': return 'Facebook';
    case 'SignInWithApple': return 'SignInWithApple';
    case 'AcmeSAML': return 'AcmeSAML';
    case 'OktaOIDC': return 'OktaOIDC';
    default: return 'cognito';
  }
}
