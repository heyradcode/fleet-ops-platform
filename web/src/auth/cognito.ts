/**
 * The real Cognito provider: hosted UI, authorization code + PKCE.
 *
 * Selected by provider.ts when VITE_COGNITO_DOMAIN and VITE_COGNITO_CLIENT_ID
 * are set; otherwise the local issuer runs. Everything above the AuthProvider
 * interface stays exactly as it is either way.
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
import { verifyTokenRs256, type PoolConfig } from '../../../src/auth/cognito-jwt-verifier.ts';
import { authorizeUrl, resolveIdpForEmail } from '../../../src/auth/providers.ts';
import { sha256Bytes, b64urlEncode, uuid } from '../../../src/platform/crypto.ts';

/**
 * The pool this build talks to, from Vite's build-time environment.
 *
 * Read lazily rather than at module scope: this module is imported whether or
 * not Cognito is configured, and a missing variable must be a clear message at
 * sign-in time, not a crash while the bundle evaluates.
 */
function config(): {
  domain: string; clientId: string; redirectUri: string; idps: string[]; pool: PoolConfig;
} {
  const domain = import.meta.env?.VITE_COGNITO_DOMAIN as string | undefined;
  const clientId = import.meta.env?.VITE_COGNITO_CLIENT_ID as string | undefined;
  const issuer = import.meta.env?.VITE_COGNITO_ISSUER as string | undefined;
  if (!domain || !clientId || !issuer) {
    throw new AuthError('Cognito is not configured for this build - see web/src/auth/provider.ts.');
  }
  return {
    domain,
    clientId,
    redirectUri: `${globalThis.location.origin}/callback`,
    // Which identity providers this POOL actually has. Home-realm discovery
    // knows which IdP a domain *should* use; only the deployment knows which
    // ones exist. Sending `identity_provider=AcmeSAML` to a pool that has no
    // SAML provider gets "Login option is not available" from the hosted UI -
    // a true statement about the pool that reads as a broken sign-in page.
    idps: (import.meta.env?.VITE_COGNITO_IDPS as string | undefined ?? 'COGNITO')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // The issuer is the JWKS root as well as the `iss` claim we require, so
    // one variable pins both. A pool id in the URL and a different one in the
    // token is precisely what check 2 exists to catch.
    pool: { issuer, clientId },
  };
}

/** True when all three variables are present. Decides which provider the UI gets. */
export function cognitoConfigured(): boolean {
  const e = import.meta.env;
  return Boolean(e?.VITE_COGNITO_DOMAIN && e?.VITE_COGNITO_CLIENT_ID && e?.VITE_COGNITO_ISSUER);
}

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
  async restore() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    try {
      // Re-verified against the pool's JWKS, not trusted because it is ours.
      return { token, principal: await verifyTokenRs256(token, config().pool) };
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
    const wanted = resolveIdpForEmail(email);
    // Fall back to the pool's own form rather than asking for a provider it
    // does not have. The offline provider still demonstrates the full
    // discovery table; this one is bounded by what was deployed.
    const available = config().idps;
    return this.signInWith(available.includes(wanted) ? wanted : 'COGNITO', email);
  },

  async signInWith(provider) {
    const { domain, clientId, redirectUri } = config();
    const { verifier, challenge } = createPkcePair();
    // `state` is CSRF protection, not decoration: on the way back it is
    // compared against what was stored, so a redirect the user did not start
    // cannot complete a sign-in.
    const state = uuid();

    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);

    globalThis.location.assign(authorizeUrl({
      domain,
      clientId,
      redirectUri,
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
    const { domain, clientId } = config();
    globalThis.location.assign(
      `https://${domain}/logout?client_id=${clientId}` +
      `&logout_uri=${encodeURIComponent(globalThis.location.origin)}`,
    );
  },
};

/**
 * Complete the redirect: exchange the code for tokens.
 *
 * Called by useRestoredSession when the page loads with a code in the URL.
 * The token endpoint is a POST with the verifier - no client secret, because
 * a SPA cannot hold one.
 *
 * What stops short of a real deployment is the last line: verifyToken() is the
 * offline verifier, HMAC against a demo secret. A pool signs RS256, so the
 * swap there is a JWKS fetch - see the note at the top of auth/index.ts.
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

  // Both are single-use. Removing them BEFORE the exchange means a retry of
  // the same URL fails the state check above instead of replaying the code.
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  const { domain, clientId, redirectUri, pool } = config();
  const res = await fetch(`https://${domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new AuthError('The identity provider rejected the sign-in. Start again.');

  const { access_token: token } = await res.json() as { access_token: string };
  // The ACCESS token, not the id token: it is what carries cognito:groups and
  // the custom claims the V2_0 trigger stamped, and what an API authorises on.
  const session = { token, principal: await verifyTokenRs256(token, pool) };
  sessionStorage.setItem(TOKEN_KEY, token);
  return session;
}
