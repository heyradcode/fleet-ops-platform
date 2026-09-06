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

type Membership = {
  tenantId: string;
  roles: string[];
  /**
   * The dispatcher's district, if they have one.
   *
   * THIS IS WHY THE TRIGGER MATTERS MORE THAN IT LOOKS. Stamping the district
   * into the token means it arrives at every downstream service SIGNED. A
   * dispatcher cannot widen their own board by editing a request, because the
   * board's scope was never in the request - it was in the token, and the
   * token's signature covers it.
   *
   * Absent means tenant-wide, which is what an admin or a regional manager
   * gets. That is a deliberate grant, not a default: see scopeFromClaims() in
   * cognito-jwt-verifier.ts, which only widens for an explicit admin role.
   */
  district?: string;
};

/** Stand-in for a DynamoDB lookup keyed by email domain or federated sub. */
function lookupTenantMembership(email: string): Membership | undefined {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const table: Record<string, Membership> = {
    // A dispatcher, scoped to one board.
    'acme-freight.com': { tenantId: 'acme-freight', roles: ['dispatcher'], district: 'dal' },
    // Safety reviewers read the whole carrier but cannot move a load.
    'safety.acme-freight.com': { tenantId: 'acme-freight', roles: ['safety'] },
    // A different carrier entirely.
    'northstar-logistics.com': { tenantId: 'northstar-logistics', roles: ['viewer'] },
    // The platform team.
    'meridian.io': { tenantId: 'acme-freight', roles: ['admin'] },
  };
  return table[domain];
}

/**
 * Drivers authenticate differently from dispatchers, and the difference is
 * architectural rather than cosmetic:
 *
 *                  Drivers                    Dispatchers
 *   Auth           mobile app, device-bound   enterprise SSO (SAML / OIDC)
 *   Scope          their own assignments      a district or region
 *   Token          long refresh, short access short, revocable
 *   Offline        must keep working          always online
 *
 * A driver's token carries no district at all - they see their own work, not a
 * board. Handing a driver a district-scoped token would show them every other
 * truck in Dallas, which is neither useful to them nor anyone's intention.
 */
function isDriverDevice(event: PreTokenGenerationEvent): boolean {
  return event.request.userAttributes['custom:deviceBound'] === 'true';
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
      // The signed scope. A driver's device-bound token never gets a district;
      // they see their own assignments and nothing else.
      ...(membership.district && !isDriverDevice(event)
        ? { 'custom:district': membership.district }
        : {}),
    },
    // Suppress claims the API does not need. Smaller tokens, less PII in logs.
    claimsToSuppress: ['given_name', 'family_name', 'phone_number'],
    // Groups become the `cognito:groups` claim -> our roles. Overriding here
    // means the IdP's group names never reach the token unmapped.
    groupOverrideDetails: { groupsToOverride: membership.roles },
  };

  return event;
}
