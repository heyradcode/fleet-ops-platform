/**
 * ---------------------------------------------------------------------------
 * Multi-tenancy: the single most important thing to get right in a SaaS demo
 * ---------------------------------------------------------------------------
 * There are three common isolation models. Be ready to name them:
 *
 *   1. Silo     - one stack (DB/table) per tenant. Strongest isolation,
 *                 worst cost/ops at scale. Used for regulated whales.
 *   2. Pool     - one table, tenantId as the partition key. Cheapest, needs
 *                 disciplined code. THIS is what we do here.
 *   3. Bridge   - pooled compute, siloed data (or vice versa). A middle ground.
 *
 * With the pool model the danger is a "cross-tenant read": some query forgets
 * its tenant filter and leaks Acme's data to Globex. Two defences:
 *
 *   a) Code: every store method takes a `Principal`, never a bare tenantId
 *      string, and derives the partition key itself. You cannot *forget* to
 *      pass the tenant because the type system will not compile.
 *
 *   b) IAM: attach a session policy with `dynamodb:LeadingKeys` scoped to the
 *      tenant, so even a buggy Lambda is refused by AWS itself. That is
 *      "dynamic tenant isolation" and is what a Solutions Architect will
 *      want to hear. Sketch below in `tenantScopedSessionPolicy`.
 */
import type { Principal, TenantId } from './types.ts';

export class CrossTenantAccessError extends Error {
  constructor(want: TenantId, got: TenantId) {
    super(`cross-tenant access denied: principal is in ${got}, requested ${want}`);
    this.name = 'CrossTenantAccessError';
  }
}

/** The partition key prefix for every item belonging to a tenant. */
export function pk(principal: Principal, entity: string): string {
  return `TENANT#${principal.tenantId}#${entity}`;
}

/** Belt-and-braces check for the rare place that takes an explicit tenantId. */
export function assertSameTenant(principal: Principal, tenantId: TenantId): void {
  if (principal.tenantId !== tenantId) {
    throw new CrossTenantAccessError(tenantId, principal.tenantId);
  }
}

export function requireRole(principal: Principal, ...allowed: Principal['roles']): void {
  if (!principal.roles.some((r) => allowed.includes(r))) {
    throw new Error(`forbidden: requires one of [${allowed.join(', ')}], has [${principal.roles.join(', ')}]`);
  }
}

/**
 * The IAM session policy an ingest/API Lambda would assume via STS before
 * touching DynamoDB. `dynamodb:LeadingKeys` restricts the *partition key* the
 * credentials may read or write, so tenant isolation is enforced by AWS rather
 * than by our own if-statements.
 */
export function tenantScopedSessionPolicy(tenantId: TenantId, tableArn: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        Resource: [tableArn, `${tableArn}/index/*`],
        Condition: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': [`TENANT#${tenantId}#*`],
          },
        },
      },
    ],
  };
}
