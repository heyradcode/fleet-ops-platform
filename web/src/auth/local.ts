/**
 * The offline auth provider: real Cognito logic, no user pool.
 *
 * Every step below is the code that would run on AWS:
 *
 *   discover()  -> resolveIdpForEmail(), the home-realm lookup
 *   signIn()    -> the PreTokenGeneration trigger, then verifyToken()'s seven
 *                  checks against the minted token
 *   signUp()    -> the shape of a PostConfirmation tenant-provisioning flow
 *
 * The two things a user pool provides and this does not: RS256 signatures
 * validated against a published JWKS, and somewhere to keep passwords. Neither
 * changes anything above the AuthProvider interface, which is the point.
 */
import type { AuthProvider, Realm, Session, SignUpRequest } from './index.ts';
import { AuthError } from './index.ts';
import {
  signDemoToken, verifyToken, TokenVerificationError,
} from '../../../src/auth/cognito-jwt-verifier.ts';
import { handler as preTokenGeneration } from '../../../src/auth/pre-token-generation.ts';
import { resolveIdpForEmail, IDENTITY_PROVIDERS } from '../../../src/auth/providers.ts';

const STORAGE_KEY = 'meridian.session';

/**
 * Accounts this demo will sign in, and what each one demonstrates.
 *
 * A real pool holds these in Cognito with the tenant and district on the user
 * record; the PreTokenGeneration trigger reads them from DynamoDB. Here the
 * trigger's own membership table does that job, and this list exists so the
 * sign-in page can offer something to click - a demo whose first screen is an
 * empty form nobody has credentials for is a demo nobody gets past.
 */
export const DEMO_ACCOUNTS = [
  {
    email: 'dispatcher@acme-freight.com',
    name: 'Dallas dispatcher',
    shows: 'Scoped to one district. The board shows Dallas and nothing else.',
  },
  {
    email: 'safety@safety.acme-freight.com',
    name: 'Safety reviewer',
    shows: 'Reads the whole carrier, but cannot move a load.',
  },
  {
    email: 'lead@meridian.io',
    name: 'Operations lead',
    shows: 'Tenant-wide scope, because of the admin role rather than a missing filter.',
  },
  {
    email: 'viewer@northstar-logistics.com',
    name: 'A different carrier',
    shows: 'Same platform, different tenant. Sees none of the above.',
  },
] as const;

function labelFor(idp: string): string {
  return idp === 'COGNITO' ? 'Continue with email' : `Continue with ${idp}`;
}

function kindFor(idp: string): Realm['kind'] {
  const provider = IDENTITY_PROVIDERS.find((p) => p.name === idp);
  if (provider?.kind === 'saml') return 'saml';
  if (provider?.kind === 'oidc') return 'oidc';
  return 'cognito';
}

/**
 * Run the PreTokenGeneration trigger and mint what it decided.
 *
 * This is the whole point of the trigger: a federated user arrives with no
 * tenant - Google knows nothing about your carrier - and this is where the
 * platform decides who they are. Everything downstream then gets tenancy and
 * scope from a signed token, with no database call on the hot path.
 */
async function mint(email: string, identityProvider: string): Promise<Session> {
  const event = await preTokenGeneration({
    version: '1',
    triggerSource: 'TokenGeneration_HostedAuth',
    userPoolId: 'us-east-1_LOCAL',
    userName: email,
    request: {
      userAttributes: { email, email_verified: 'true' },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] },
    },
    response: {},
  });

  const claims = event.response.claimsOverrideDetails?.claimsToAddOrOverride ?? {};
  const groups = event.response.claimsOverrideDetails?.groupOverrideDetails?.groupsToOverride ?? [];

  // FAIL CLOSED. An unknown domain gets no tenant, and rather than minting a
  // token that every downstream query will reject with something cryptic, say
  // so here in terms the person can act on.
  if (!claims['custom:tenantId']) {
    throw new AuthError(
      `No carrier is registered for ${email.split('@')[1] ?? 'that domain'}. ` +
      'Ask your operations lead to add you, or register the carrier.',
    );
  }

  const token = signDemoToken({
    sub: `${identityProvider}_${email}`,
    email,
    'custom:tenantId': claims['custom:tenantId'],
    ...(claims['custom:district'] ? { 'custom:district': claims['custom:district'] } : {}),
    'cognito:groups': groups,
    identities: identityProvider === 'COGNITO'
      ? undefined
      : [{ providerName: identityProvider, userId: email }],
  });

  try {
    // The same verifier the API runs. Doing it here too means the client never
    // holds a token it has not itself checked - and it is where a tampered or
    // expired token is caught before anything is rendered.
    return { token, principal: verifyToken(token) };
  } catch (err) {
    if (err instanceof TokenVerificationError) {
      throw new AuthError(`Sign-in failed: ${err.message}.`);
    }
    throw err;
  }
}

function persist(session: Session): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, session.token);
  } catch {
    // Private browsing, or storage disabled. Signing in still works for this
    // tab; it just will not survive a reload. Not worth failing over.
  }
}

export const localAuth: AuthProvider = {
  restore() {
    let token: string | null = null;
    try {
      token = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
    if (!token) return null;

    try {
      // Re-verify on every restore rather than trusting what was stored. A
      // token in sessionStorage is attacker-writable if anything else on the
      // origin is compromised, and an expired one must not survive a reload.
      return { token, principal: verifyToken(token) };
    } catch {
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return null;
    }
  },

  discover(email) {
    const idp = resolveIdpForEmail(email);
    return { idp, kind: kindFor(idp), label: labelFor(idp) };
  },

  async signIn(email) {
    const { idp } = this.discover(email);
    const session = await mint(email, idp);
    persist(session);
    return session;
  },

  async signInWith(provider, email) {
    const session = await mint(email, provider);
    persist(session);
    return session;
  },

  async signUp(request: SignUpRequest) {
    // NOT self-serve access, and the difference is not pedantry. A dispatcher
    // does not sign themselves up for a carrier's fleet platform - the carrier
    // is onboarded, its SSO is configured, and its people arrive through it.
    // What this form starts is the PostConfirmation flow: create the tenant
    // row, seed its districts, and hand the domain to home-realm discovery.
    //
    // Modelling it as "request access" rather than "create account" is also
    // the honest thing to show: nothing here can grant access to fleet data.
    const domain = request.email.split('@')[1];
    if (!domain) throw new AuthError('That does not look like an email address.');

    if (resolveIdpForEmail(request.email) !== 'COGNITO') {
      throw new AuthError(
        `${domain} is already registered and uses single sign-on. ` +
        'Sign in with your work email instead.',
      );
    }

    return {
      message:
        `Request received for ${request.carrierName}. Onboarding creates the ` +
        `tenant, seeds its districts, and points ${domain} at your identity ` +
        'provider — an operations lead confirms it before anyone can sign in.',
    };
  },

  signOut() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  },
};
