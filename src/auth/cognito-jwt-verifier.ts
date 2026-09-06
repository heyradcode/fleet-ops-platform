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
 * This file uses HMAC so the demo can sign its own tokens offline. The
 * verification LOGIC below is the real logic; only the algorithm differs.
 */
import { b64urlDecode, b64urlDecodeText, b64urlEncode, hmacSha256, timingSafeEqual } from '../platform/crypto.ts';
import type { Principal, TenantId } from '../platform/types.ts';

const DEMO_SECRET = 'demo-only-not-a-real-signing-key';
const ISSUER = process.env.COGNITO_ISSUER ?? 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123DEF';
const CLIENT_ID = process.env.COGNITO_APP_CLIENT_ID ?? '1h57kf5cpq17m0eml12EXAMPLE';

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
  const now = Math.floor(Date.now() / 1000);
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
export function verifyToken(token: string): Principal {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenVerificationError('not a three-part JWS');

  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(b64urlDecodeText(headerB64)) as { alg: string; kid?: string };

  // Check 7 first: never trust the token to tell you how to check the token.
  if (header.alg !== 'HS256') throw new TokenVerificationError('unexpected alg ' + header.alg);

  // Check 1: signature. timingSafeEqual, not ===, to avoid a timing oracle.
  const expected = hmacSha256(DEMO_SECRET, headerB64 + '.' + payloadB64);
  const actual = unb64url(sigB64);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new TokenVerificationError('signature mismatch');
  }

  const claims = JSON.parse(b64urlDecodeText(payloadB64)) as CognitoClaims;
  const now = Math.floor(Date.now() / 1000);

  if (claims.iss !== ISSUER) throw new TokenVerificationError('wrong issuer');                    // 2
  if (claims.client_id !== CLIENT_ID) throw new TokenVerificationError('wrong client_id');        // 3
  if (claims.token_use !== 'access') throw new TokenVerificationError('expected an access token');// 4
  if (claims.exp <= now) throw new TokenVerificationError('expired');                             // 5
  if (claims.iat > now + 60) throw new TokenVerificationError('issued in the future');            // 6
  if (!claims['custom:tenantId']) throw new TokenVerificationError('no tenant claim');

  return {
    sub: claims.sub,
    email: claims.email,
    tenantId: claims['custom:tenantId'],
    roles: mapGroupsToRoles(claims['cognito:groups'] ?? []),
    identityProvider: providerFromIdentities(claims.identities),
  };
}

/**
 * Cognito groups are strings; our code wants a closed union. Mapping here means
 * a typo in the Cognito console degrades to "no role" rather than crashing, and
 * an unexpected group can never silently become an admin.
 */
function mapGroupsToRoles(groups: string[]): Principal['roles'] {
  const valid: Principal['roles'] = [];
  for (const g of groups) {
    if (g === 'admin' || g === 'operator' || g === 'viewer') valid.push(g);
  }
  return valid.length > 0 ? valid : ['viewer'];
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
