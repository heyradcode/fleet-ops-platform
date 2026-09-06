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
    /** V1 shape. Reaches the ID TOKEN only - see applyOverrides(). */
    claimsOverrideDetails?: TokenClaimOverride & {
      groupOverrideDetails?: { groupsToOverride: string[] };
    };
    /** V2_0 shape. The only one that can write to the ACCESS token. */
    claimsAndScopeOverrideDetails?: {
      accessTokenGeneration?: TokenClaimOverride;
      idTokenGeneration?: TokenClaimOverride;
      groupOverrideDetails?: { groupsToOverride: string[] };
    };
  };
};

type TokenClaimOverride = {
  claimsToAddOrOverride?: Record<string, string>;
  claimsToSuppress?: string[];
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

/**
 * Write the overrides in the shape this trigger VERSION expects.
 *
 * THIS IS NOT A COMPATIBILITY SHIM, it is the difference between a pool that
 * works and one that cannot sign anybody in. A V1 trigger writes claims to the
 * ID token only. Everything downstream reads tenant and district from the
 * ACCESS token - `token_use: 'access'` is check 4 in the verifier, because the
 * access token is what an API authorises on. Wire a pool to V1 and it happily
 * mints access tokens with no tenant claim, the verifier correctly rejects
 * them for exactly that, and the failure looks like a broken verifier rather
 * than a trigger written to the wrong version.
 *
 * V2_0 is therefore the only version this design can use. V1 stays supported
 * here because the offline provider and the tests drive the trigger directly.
 */
function applyOverrides(
  event: PreTokenGenerationEvent,
  claimsToAddOrOverride: Record<string, string>,
  claimsToSuppress: string[],
  groupsToOverride: string[],
): PreTokenGenerationEvent {
  const groupOverrideDetails = { groupsToOverride };

  if (event.version.startsWith('2')) {
    // Both tokens get the claims. The access token is the one that matters;
    // the id token carries them so a client can render "you are in Dallas"
    // without a second call.
    const claims = { claimsToAddOrOverride, claimsToSuppress };
    event.response.claimsAndScopeOverrideDetails = {
      accessTokenGeneration: claims,
      idTokenGeneration: claims,
      groupOverrideDetails,
    };
    return event;
  }

  event.response.claimsOverrideDetails = {
    claimsToAddOrOverride, claimsToSuppress, groupOverrideDetails,
  };
  return event;
}

export async function handler(event: PreTokenGenerationEvent): Promise<PreTokenGenerationEvent> {
  const email = event.request.userAttributes.email ?? '';
  const membership = lookupTenantMembership(email);

  if (!membership) {
    // Fail CLOSED: an unknown domain gets no tenant, and every tenant-scoped
    // query will reject the request. Better than guessing a tenant. The empty
    // group list is part of that - no tenant means no roles either.
    return applyOverrides(
      event,
      { 'custom:tenantId': '', 'custom:onboarding': 'pending' },
      [],
      [],
    );
  }

  return applyOverrides(
    event,
    {
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
    ['given_name', 'family_name', 'phone_number'],
    // Groups become the `cognito:groups` claim -> our roles. Overriding here
    // means the IdP's group names never reach the token unmapped.
    membership.roles,
  );
}
