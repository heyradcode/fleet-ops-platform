import { b64urlEncode } from '../platform/crypto.ts';
/**
 * ---------------------------------------------------------------------------
 * Cognito PreTokenGeneration Lambda trigger
 * ---------------------------------------------------------------------------
 * THE key trigger for multi-tenant SaaS. It runs after authentication but
 * before Cognito signs the tokens, and lets you add or override claims.
 *
 * Why it matters: a Google user has no tenant. Google knows nothing about your
 * SaaS. This trigger is where you look up "which tenant does alice@acme.com
 * belong to, and what is she allowed to do", and stamp it into the token.
 * Every downstream service then gets tenancy for free, from a signed token,
 * with no extra database call on the hot path.
 *
 * Other triggers worth naming:
 *   PreSignUp            - auto-confirm, or link a federated user to an
 *                          existing native account (identity linking).
 *   PostConfirmation     - create the tenant row / seed default data.
 *   PreAuthentication    - block a suspended tenant before login succeeds.
 *   CustomMessage        - brand the verification emails.
 *   DefineAuthChallenge  - custom MFA / passwordless flows.
 *
 * Rules for this handler:
 *   - It is on the critical path of every login. Keep it fast (<100ms) and give
 *     it a provisioned-concurrency alias if p99 matters.
 *   - Throwing here blocks the login entirely. Fail OPEN to a viewer role for
 *     transient errors; fail CLOSED only for genuine authorisation failures.
 *   - Claims are not free: tokens go in an Authorization header, and headers
 *     have size limits. Put ids in the token, not objects.
 */

export type PreTokenGenerationEvent = {
  version: string;
  triggerSource: 'TokenGeneration_Authentication' | 'TokenGeneration_HostedAuth' | 'TokenGeneration_RefreshTokens';
  userPoolId: string;
  userName: string;
  request: {
    userAttributes: Record<string, string>;
    groupConfiguration: { groupsToOverride: string[]; iamRolesToOverride: string[]; preferredRole?: string };
  };
  response: {
    claimsOverrideDetails?: {
      claimsToAddOrOverride?: Record<string, string>;
      claimsToSuppress?: string[];
      groupOverrideDetails?: { groupsToOverride: string[] };
    };
  };
};

/** Stand-in for a DynamoDB lookup keyed by email domain or federated sub. */
function lookupTenantMembership(email: string): { tenantId: string; roles: string[] } | undefined {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const table: Record<string, { tenantId: string; roles: string[] }> = {
    'acme.com': { tenantId: 'acme', roles: ['operator'] },
    'globex.com': { tenantId: 'globex', roles: ['viewer'] },
    'meridian.io': { tenantId: 'acme', roles: ['admin'] },
  };
  return table[domain];
}

export async function handler(event: PreTokenGenerationEvent): Promise<PreTokenGenerationEvent> {
  const email = event.request.userAttributes.email ?? '';
  const membership = lookupTenantMembership(email);

  if (!membership) {
    // Fail CLOSED: an unknown domain gets no tenant, and every tenant-scoped
    // query will reject the request. Better than guessing a tenant.
    event.response.claimsOverrideDetails = {
      claimsToAddOrOverride: { 'custom:tenantId': '', 'custom:onboarding': 'pending' },
    };
    return event;
  }

  event.response.claimsOverrideDetails = {
    claimsToAddOrOverride: {
      'custom:tenantId': membership.tenantId,
      // A stable id the app can send to support without leaking the email.
      'custom:principalRef': b64urlEncode(email).slice(0, 16),
    },
    // Suppress claims the API does not need. Smaller tokens, less PII in logs.
    claimsToSuppress: ['given_name', 'family_name', 'phone_number'],
    // Groups become the `cognito:groups` claim -> our roles. Overriding here
    // means the IdP's group names never reach the token unmapped.
    groupOverrideDetails: { groupsToOverride: membership.roles },
  };

  return event;
}
