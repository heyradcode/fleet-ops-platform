/**
 * ---------------------------------------------------------------------------
 * Tenant membership: which carrier an identity belongs to
 * ---------------------------------------------------------------------------
 * This is the smallest, most load-bearing lookup in the platform. It decides,
 * for one email address, the tenant whose data that person may ever see - and
 * the PreTokenGeneration trigger then stamps the answer into a signed token,
 * so everything downstream inherits it without asking again.
 *
 * A REGISTRY, for the same reason `runbook-loader.ts` is one.
 *
 * The trigger handler is imported by the browser: `web/src/auth/local.ts`
 * calls it directly so the offline board runs Cognito's real logic. A bundler
 * resolves imports whether or not the code path executes, so a static
 * `@aws-sdk/client-dynamodb` in the trigger would break the web build - the
 * same class of failure as the `node:fs` and `process.env` bugs recorded in
 * CLAUDE.md, and one CI would NOT catch, because the portability check greps
 * for `node:` builtins and an SDK package is not one.
 *
 * So the lookup is an injected function. The default is the built-in table,
 * which is what `pnpm start`, the tests and the offline board all use - none
 * of them need AWS credentials, and none of them changed when DynamoDB
 * arrived. The deployed Lambda calls setMembershipLookup() at startup with
 * the adapter in `membership.dynamodb.ts`, which the browser never imports.
 *
 * Same shape as the two boundaries above it: one interface, two
 * implementations, chosen by configuration rather than by a build flag.
 */

export type Membership = {
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

/** Async because a real one is a network call. The built-in one just resolves. */
export type MembershipLookup = (email: string) => Promise<Membership | undefined>;

/**
 * The demo carriers, keyed by email DOMAIN.
 *
 * Also the seed data for the deployed table - `infra/terraform/auth/` writes
 * these same four rows, so the offline board and the real pool agree about who
 * belongs where. Exported for that reason: two copies of this would drift, and
 * a tenant rename has already caught this repository out once.
 *
 * Keying on the domain assumes everyone at a carrier gets identical scope,
 * which is true here and false in general - the moment two dispatchers at one
 * carrier need different districts, the key has to become the federated `sub`.
 * The DynamoDB adapter takes whatever key it is given, so that change is a
 * change to this function and the seed rows, not to the storage.
 */
export const DEMO_MEMBERSHIPS: Record<string, Membership> = {
  // A dispatcher, scoped to one board.
  'acme-freight.com': { tenantId: 'acme-freight', roles: ['dispatcher'], district: 'dal' },
  // Safety reviewers read the whole carrier but cannot move a load.
  'safety.acme-freight.com': { tenantId: 'acme-freight', roles: ['safety'] },
  // A different carrier entirely.
  'northstar-logistics.com': { tenantId: 'northstar-logistics', roles: ['viewer'] },
  // The platform team.
  'meridian.io': { tenantId: 'acme-freight', roles: ['admin'] },
};

/** The lookup key. One function, so the storage and the trigger cannot disagree. */
export function membershipKey(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

const builtIn: MembershipLookup = (email) =>
  Promise.resolve(DEMO_MEMBERSHIPS[membershipKey(email)]);

let current: MembershipLookup = builtIn;

/**
 * Point the lookup at a real store. Called by the Lambda entry point, never
 * by anything the browser loads.
 */
export function setMembershipLookup(lookup: MembershipLookup): void {
  current = lookup;
}

/** Restore the built-in table. Tests use this to undo an adapter. */
export function resetMembershipLookup(): void {
  current = builtIn;
}

export function lookupTenantMembership(email: string): Promise<Membership | undefined> {
  return current(email);
}
