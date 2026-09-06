/**
 * The real Cognito provider: hosted UI, authorization code + PKCE.
 *
 * Unused offline - there is no user pool - and present so the swap is a
 * configuration change rather than a rewrite. Everything above the
 * AuthProvider interface stays exactly as it is.
 *
 * WHY AUTHORIZATION CODE + PKCE, and not the alternatives:
 *
 *   implicit          returns the token in the URL fragment, where it lands in
 *                     browser history, in Referer headers and in any analytics
 *                     script on the page. Deprecated, and rightly.
 *   code, no PKCE     safe for a server that can keep a client secret. A SPA
 *                     cannot keep a secret - it ships to the browser - so an
 *                     intercepted code is redeemable by whoever took it.
 *   code + PKCE       the client proves, at redemption, that it is the same
 *                     client that started the flow. No secret required.
 *
 * The verifier never leaves the browser; only its SHA-256 does. That is the
 * whole mechanism.
 */
import type { AuthProvider, Realm, Session, SignUpRequest } from './index.ts';
import { AuthError } from './index.ts';
import { verifyToken } from '../../../src/auth/cognito-jwt-verifier.ts';
import { authorizeUrl, resolveIdpForEmail } from '../../../src/auth/providers.ts';
import { sha256Bytes, b64urlEncode, uuid } from '../../../src/platform/crypto.ts';

const DOMAIN = 'meridian-prod.auth.us-east-1.amazoncognito.com';
const CLIENT_ID = '1h57kf5cpq17m0eml12EXAMPLE';
const REDIRECT_URI = globalThis.location?.origin
  ? `${globalThis.location.origin}/callback`
  : 'https://app.meridian.example.com/callback';

const VERIFIER_KEY = 'meridian.pkce.verifier';
const STATE_KEY = 'meridian.pkce.state';
const TOKEN_KEY = 'meridian.session';

/**
 * The PKCE pair.
 *
 * The verifier is a high-entropy random string kept in this browser. The
 * challenge is its SHA-256, sent when the flow starts. At redemption the
 * verifier is presented; Cognito hashes it and compares. An attacker who
 * intercepted the authorization code never saw the verifier, so cannot redeem.
 */
function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = (uuid() + uuid()).replace(/-/g, '');
  const challenge = b64urlEncode(sha256Bytes(new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export const cognitoAuth: AuthProvider = {
  restore() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    try {
      return { token, principal: verifyToken(token) };
    } catch {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
  },

  discover(email): Realm {
    const idp = resolveIdpForEmail(email);
    return {
      idp,
      kind: idp === 'COGNITO' ? 'cognito' : 'saml',
      label: idp === 'COGNITO' ? 'Continue with email' : `Continue with ${idp}`,
    };
  },

  async signIn(email) {
    return this.signInWith(resolveIdpForEmail(email), email);
  },

  async signInWith(provider) {
    const { verifier, challenge } = createPkcePair();
    // `state` is CSRF protection, not decoration: on the way back it is
    // compared against what was stored, so a redirect the user did not start
    // cannot complete a sign-in.
    const state = uuid();

    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);

    globalThis.location.assign(authorizeUrl({
      domain: DOMAIN,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      identityProvider: provider,
      codeChallenge: challenge,
      state,
    }));

    // The page navigates away, so this never resolves. Typed as a promise
    // because the interface is the same either way.
    return new Promise<Session>(() => {});
  },

  async signUp(_request: SignUpRequest) {
    // Cognito's own sign-up API is deliberately not wired here. Self-serve
    // registration into a fleet platform would let anyone create a tenant next
    // to real carriers; onboarding runs through the operations team.
    throw new AuthError('Carrier onboarding is handled by the operations team.');
  },

  signOut() {
    sessionStorage.removeItem(TOKEN_KEY);
    // Clearing local state is not signing out. The Cognito session cookie is
    // still live, so the next /authorize returns a token without prompting -
    // which looks exactly like the sign-out having failed. Hit /logout too.
    globalThis.location.assign(
      `https://${DOMAIN}/logout?client_id=${CLIENT_ID}` +
      `&logout_uri=${encodeURIComponent(globalThis.location.origin)}`,
    );
  },
};

/**
 * Complete the redirect: exchange the code for tokens.
 *
 * Called from the /callback route. The token endpoint is a POST with the
 * verifier - no client secret, because a SPA cannot hold one.
 *
 *   const res = await fetch(`https://${DOMAIN}/oauth2/token`, {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
 *     body: new URLSearchParams({
 *       grant_type: 'authorization_code',
 *       client_id: CLIENT_ID,
 *       code,
 *       redirect_uri: REDIRECT_URI,
 *       code_verifier: verifier,
 *     }),
 *   });
 */
export async function completeRedirect(searchParams: URLSearchParams): Promise<Session> {
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  if (searchParams.get('error')) {
    throw new AuthError(searchParams.get('error_description') ?? 'Sign-in was cancelled.');
  }
  if (!code) throw new AuthError('The sign-in response was missing its code.');

  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!state || state !== expectedState) {
    // A mismatch means this redirect did not come from a flow this browser
    // started. Refuse it rather than trying to recover.
    throw new AuthError('Sign-in could not be verified. Start again.');
  }

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new AuthError('Sign-in expired. Start again.');

  throw new AuthError(
    'Token exchange needs a deployed user pool. This build uses the offline ' +
    'provider — see web/src/auth/local.ts.',
  );
}
