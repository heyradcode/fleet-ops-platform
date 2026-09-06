/**
 * ---------------------------------------------------------------------------
 * Cognito identity federation: social + enterprise SSO
 * ---------------------------------------------------------------------------
 * A fleet platform needs social providers (Google, Apple) for owner-operators
 * AND enterprise SSO (SAML 2.0, OIDC) for the carriers. Cognito handles all of
 * them the same way: each is an "identity provider" attached to the user pool,
 * and each needs an ATTRIBUTE MAPPING from the provider's claim names to your
 * user pool's attributes.
 *
 * THE FLOW (authorization code + PKCE - the only correct choice for a SPA;
 * the implicit flow is deprecated and leaks tokens in the URL fragment):
 *
 *   1. App -> GET /oauth2/authorize?identity_provider=Google
 *             &response_type=code&client_id=..&redirect_uri=..
 *             &code_challenge=..&code_challenge_method=S256
 *   2. Cognito bounces the user to Google. User authenticates there.
 *   3. Google -> Cognito with an authorization code. Cognito swaps it for
 *      Google tokens, reads the claims, and applies your attribute mapping.
 *   4. Cognito fires the PreTokenGeneration trigger (see pre-token-generation.ts)
 *      so you can inject tenant + role claims.
 *   5. Cognito -> your redirect_uri with ITS OWN code.
 *   6. App -> POST /oauth2/token with the code + code_verifier
 *      -> { id_token, access_token, refresh_token }
 *
 * The app only ever sees Cognito tokens. Google/Okta/ADFS tokens never reach
 * your front-end, and your API only trusts one issuer. That single-issuer
 * property is the whole reason to put Cognito in front of five IdPs.
 */

export type SocialProvider = {
  kind: 'social';
  name: 'Google' | 'Facebook' | 'SignInWithApple';
  /** Cognito attribute <- provider claim. */
  attributeMapping: Record<string, string>;
  scopes: string[];
  notes: string;
};

export type SamlProvider = {
  kind: 'saml';
  name: string;
  /** Enterprises give you a metadata URL; Cognito re-fetches it as certs rotate. */
  metadataUrl: string;
  attributeMapping: Record<string, string>;
  notes: string;
};

export type OidcProvider = {
  kind: 'oidc';
  name: string;
  issuer: string;
  attributeMapping: Record<string, string>;
  scopes: string[];
  notes: string;
};

export const IDENTITY_PROVIDERS: Array<SocialProvider | SamlProvider | OidcProvider> = [
  {
    kind: 'social',
    name: 'Google',
    scopes: ['profile', 'email', 'openid'],
    attributeMapping: {
      email: 'email',
      email_verified: 'email_verified',
      given_name: 'given_name',
      family_name: 'family_name',
      username: 'sub',
    },
    notes:
      'Map username to Google sub, never to email: people change their email ' +
      'address, and a username collision merges two humans into one account.',
  },
  {
    kind: 'social',
    name: 'Facebook',
    scopes: ['public_profile', 'email'],
    attributeMapping: { email: 'email', name: 'name', username: 'id' },
    notes:
      'Facebook can return a user with NO email (phone-number signups). Make ' +
      'email optional in the pool schema or federation fails at the last step.',
  },
  {
    kind: 'social',
    name: 'SignInWithApple',
    scopes: ['email', 'name'],
    attributeMapping: { email: 'email', name: 'name', username: 'sub' },
    notes:
      'Apple sends name ONLY on the very first authorisation, and Private Relay ' +
      'gives you a @privaterelay.appleid.com address. Persist the name on first ' +
      'login; you will never see it again. Also: the client secret is a JWT you ' +
      'sign with a .p8 key and it EXPIRES (6 months max) - automate the rotation.',
  },
  {
    kind: 'saml',
    name: 'AcmeSAML',
    metadataUrl: 'https://sso.acme-freight.example.com/FederationMetadata/2007-06/FederationMetadata.xml',
    attributeMapping: {
      email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      'custom:tenantId': 'http://schemas.acme-freight.com/claims/carrier',
      // The dispatcher's district, straight out of the corporate directory.
      // Mapping it here means the board's scope is signed by Cognito rather
      // than asserted by the client.
      'custom:district': 'http://schemas.acme-freight.com/claims/district',
    },
    notes:
      'SAML claim names are URIs - copy them exactly from the IdP metadata. ' +
      'Prefer the metadata URL over pasting XML so Cognito picks up certificate ' +
      'rotation automatically; a hard-coded cert WILL expire at 2am on a Sunday.',
  },
  {
    kind: 'oidc',
    name: 'OktaOIDC',
    issuer: 'https://northstar-logistics.okta.com/oauth2/default',
    scopes: ['openid', 'profile', 'email', 'groups'],
    attributeMapping: {
      email: 'email',
      'custom:tenantId': 'org_id',
      'custom:district': 'district',
      'cognito:groups': 'groups',
    },
    notes:
      'OIDC is far less painful than SAML: JSON not XML, and discovery via ' +
      '/.well-known/openid-configuration. Prefer it whenever the customer offers ' +
      'both. Request the groups scope explicitly - Okta omits it otherwise.',
  },
];

/**
 * Which IdP should this email be sent to? Enterprises expect "type your work
 * email, land on your own login page" - HOME REALM DISCOVERY. Cognito has no
 * built-in support, so you build this lookup (backed by DynamoDB in production)
 * and pass the result as `identity_provider` on the /authorize call.
 */
const DOMAIN_TO_IDP: Record<string, string> = {
  'acme-freight.com': 'AcmeSAML',
  'acme-freight.co.uk': 'AcmeSAML',
  'northstar-logistics.com': 'OktaOIDC',
};

export function resolveIdpForEmail(email: string): string {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return DOMAIN_TO_IDP[domain] ?? 'COGNITO';
}

/** The hosted-UI URL, with PKCE. */
export function authorizeUrl(opts: {
  domain: string;
  clientId: string;
  redirectUri: string;
  identityProvider: string;
  codeChallenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    identity_provider: opts.identityProvider,
    scope: 'openid email profile',
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    state: opts.state,          // CSRF protection - verify it on the way back
  });
  return 'https://' + opts.domain + '/oauth2/authorize?' + params;
}
