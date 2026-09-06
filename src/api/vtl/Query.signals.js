/**
 * ===========================================================================
 * APPSYNC_JS unit resolver - Query.signals
 * ===========================================================================
 * The modern replacement for VTL. Same idea, real JavaScript, and you can
 * unit test it. Deployed with runtime = { name: "APPSYNC_JS", runtimeVersion:
 * "1.0.0" } on the resolver.
 *
 * RESTRICTIONS - these trip people up, so know them:
 *   - No async/await, no promises, no fetch, no require/import of npm packages.
 *   - Only the AppSync utility modules (@aws-appsync/utils).
 *   - Exactly two exported functions: request() and response().
 *   - 32KB of code after bundling.
 *
 * Anything you cannot do inside those limits is a signal you needed a Lambda
 * data source, not that you should fight the runtime.
 *
 * WHY BOTHER instead of just using Lambda everywhere? No cold start, no Lambda
 * invocation charge, one less thing to deploy and monitor. For a plain
 * DynamoDB Query this is strictly better.
 */
import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const tenantId = ctx.identity.claims['custom:tenantId'];
  if (!tenantId) util.unauthorized();

  const limit = Math.min(ctx.args.limit ?? 25, 100);

  return {
    operation: 'Query',
    query: {
      // Query, not Scan. The expression uses the partition key only, so the
      // read cost is proportional to what we return.
      expression: 'PK = :pk',
      expressionValues: util.dynamodb.toMapValues({
        ':pk': `TENANT#${tenantId}#SIGNAL`,
      }),
    },
    // Newest first: our SK starts with the ISO timestamp, so descending order
    // on the sort key IS reverse-chronological. No sorting in code, ever.
    scanIndexForward: false,
    limit,
    // The opaque cursor the client sent us last time.
    nextToken: ctx.args.nextToken,
    // A filter runs AFTER the read - it reduces the payload, not the cost.
    // Acceptable here because the partition is small and bounded by `limit`.
    filter: ctx.args.severity
      ? {
          expression: 'severity = :sev',
          expressionValues: util.dynamodb.toMapValues({ ':sev': ctx.args.severity }),
        }
      : undefined,
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  return {
    items: ctx.result.items,
    // Pass DynamoDB's LastEvaluatedKey straight back through as the cursor.
    // AppSync encodes it for you, so the client never sees the key schema.
    nextToken: ctx.result.nextToken,
  };
}
