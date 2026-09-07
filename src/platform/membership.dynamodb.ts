/**
 * The DynamoDB adapter for the membership registry.
 *
 * NODE ONLY. Nothing the browser loads may import this file - it pulls in
 * `@aws-sdk/client-dynamodb`, and a bundler resolves imports whether or not
 * the code path runs. `membership.ts` explains why that matters here more
 * than it looks: the trigger handler is in the web module graph.
 *
 * The mirror of `runbook-loader.node.ts`, and for the same reason: one
 * registry, two adapters, neither aware of the other.
 *
 * The client is created at MODULE scope. A Lambda container is reused across
 * invocations, so this is constructed once per cold start and its connection
 * pool and credential cache survive - build it inside the handler and you pay
 * for TLS and credential resolution on every single login.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { setMembershipLookup, membershipKey, type Membership } from './membership.ts';
import { log } from './logger.ts';

/** `TENANT_MEMBERSHIP#acme-freight.com`. Matches the seed rows in Terraform. */
export function membershipPk(email: string): string {
  return 'TENANT_MEMBERSHIP#' + membershipKey(email);
}

/**
 * Read membership from DynamoDB instead of the built-in table.
 *
 * ConsistentRead is deliberately OFF. An eventually-consistent read costs half
 * as much and is served from any replica; the staleness window is milliseconds,
 * and a carrier onboarded a moment ago waiting one more moment to sign in is
 * not a problem worth paying double for on every login in the system.
 */
export function useDynamoMembership(tableName: string): void {
  const client = new DynamoDBClient({});

  setMembershipLookup(async (email) => {
    const key = membershipKey(email);
    if (!key) return undefined;

    try {
      const { Item } = await client.send(new GetItemCommand({
        TableName: tableName,
        Key: { PK: { S: membershipPk(email) } },
      }));
      if (!Item) return undefined;

      return {
        tenantId: Item.tenantId?.S ?? '',
        roles: Item.roles?.SS ?? [],
        ...(Item.district?.S ? { district: Item.district.S } : {}),
      } satisfies Membership;
    } catch (err) {
      // FAIL CLOSED on a lookup error, and say so loudly.
      //
      // The file's own guidance is to fail OPEN to a viewer role on transient
      // errors - but that guidance is about a user whose membership is known.
      // Here the membership is exactly what could not be read, so there is no
      // tenant to be a viewer OF, and inventing one would hand a stranger a
      // token scoped to somebody's fleet. Returning undefined routes into the
      // trigger's existing unregistered path: a signed-in user who sees
      // nothing, which is recoverable, unlike the alternative.
      log.error('membership lookup failed', {
        domain: key,
        table: tableName,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  });
}
