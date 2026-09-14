/**
 * ============================================================================
 * Query.observations - an APPSYNC_JS unit resolver
 * ============================================================================
 * The modern replacement for VTL, and the one to reach for. Same deal: runs
 * INSIDE AppSync, no Lambda, no cold start, no per-invocation charge - but it
 * is JavaScript, so it has types in the editor, real error messages, and
 * conditionals that do not require counting `#if` directives.
 *
 * THE RESTRICTIONS ARE REAL and worth knowing before you plan around it:
 *   - no async/await, no promises
 *   - no network calls, no require()/import of anything but @aws-appsync/utils
 *   - 32KB of code after bundling
 *   - one data-source operation per unit resolver (chain them in a PIPELINE)
 *
 * So this is the right place for "read one partition and shape the result",
 * and the wrong place for anything that calls Bedrock or joins two tables.
 * Those go to the Lambda data source in appsync-resolvers.ts.
 *
 * WHY THE SORT KEY STARTS WITH A TIMESTAMP: "this tenant's observations, newest
 * first" becomes one Query with a range condition and ScanIndexForward false.
 * No scan, no filter, and read cost proportional to the ANSWER rather than to
 * the table. That is the whole argument for designing keys from access
 * patterns instead of from entities.
 */
import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const tenantId = ctx.identity.claims['custom:tenantId'];

  // Fail closed. A token with no tenant claim must never reach a query with an
  // empty partition key.
  if (!tenantId) util.unauthorized();

  const limit = Math.min(ctx.args.limit ?? 25, 100);

  // The cursor is opaque to the client and carries our own sort-key position.
  // Never hand back DynamoDB's LastEvaluatedKey directly - it spells out the
  // key schema, and a client that parses it is a migration you cannot make.
  const nextToken = ctx.args.nextToken
    ? JSON.parse(util.base64Decode(ctx.args.nextToken)).after
    : undefined;

  return {
    operation: 'Query',
    query: {
      expression: '#pk = :pk' + (nextToken ? ' AND #sk < :after' : ''),
      expressionNames: nextToken ? { '#pk': 'PK', '#sk': 'SK' } : { '#pk': 'PK' },
      expressionValues: nextToken
        ? util.dynamodb.toMapValues({
          ':pk': `TENANT#${tenantId}#OBSERVATION`,
          ':after': nextToken,
        })
        : util.dynamodb.toMapValues({ ':pk': `TENANT#${tenantId}#OBSERVATION` }),
    },
    // Newest first. The board reads the top of this list and nothing else.
    scanIndexForward: false,
    limit,
    // A filter, if one was asked for. NOTE that a DynamoDB filter does not
    // reduce read cost - the items are read and then discarded - so this is
    // acceptable on a small partition and would need a sparse GSI if severity
    // became a hot access pattern.
    filter: ctx.args.severity
      ? {
        expression: '#sev = :sev',
        expressionNames: { '#sev': 'severity' },
        expressionValues: util.dynamodb.toMapValues({ ':sev': ctx.args.severity }),
      }
      : undefined,
  };
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);

  const items = (ctx.result.items ?? []).map((item) => {
    // Strip the key attributes at the boundary, so nothing outside the data
    // layer learns the key layout.
    const { PK, SK, GSI1PK, GSI1SK, entity, ...rest } = item;
    return rest;
  });

  // Only issue a cursor when there is plausibly more. Handing back a token on
  // the last page makes clients loop once for nothing, every time.
  const last = items[items.length - 1];
  const nextToken = items.length === (ctx.args.limit ?? 25) && last
    ? util.base64Encode(JSON.stringify({ after: `${last.observedAt}#${last.observationId}` }))
    : null;

  return { items, nextToken };
}
