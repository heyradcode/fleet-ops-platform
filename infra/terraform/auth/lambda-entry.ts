/**
 * The deployed trigger's entry point.
 *
 * WHY THIS FILE EXISTS AT ALL. The handler in `src/auth/pre-token-generation.ts`
 * is imported by the browser - `web/src/auth/local.ts` runs it so the offline
 * board exercises Cognito's real logic. A bundler resolves imports whether or
 * not the code path executes, so wiring the DynamoDB adapter inside the
 * handler would drag `@aws-sdk/client-dynamodb` into the web bundle and break
 * `pnpm web:build`. CI would not catch it: the portability check greps for
 * `node:` builtins, and an SDK package is not one.
 *
 * So the wiring happens HERE, in a file only esbuild reads, and the shared
 * handler stays free of it. The same separation as
 * `platform/runbook-loader.node.ts`, one directory further out because this
 * one belongs to the deployment rather than to the platform.
 *
 * At MODULE scope, so it runs once per cold start rather than once per login.
 */
import { useDynamoMembership } from '../../../src/platform/membership.dynamodb.ts';
import { env } from '../../../src/platform/env.ts';
import { log } from '../../../src/platform/logger.ts';

const table = env('MEMBERSHIP_TABLE_NAME', '');

if (table) {
  useDynamoMembership(table);
} else {
  // Not fatal, and not silent. Terraform always sets this, so an unset
  // variable means something is wrong with the deployment rather than with
  // the request - and the built-in table WILL answer, which is the confusing
  // outcome worth a line in the log: sign-ins keep working while carriers
  // added to DynamoDB are invisible.
  log.warn('MEMBERSHIP_TABLE_NAME unset - falling back to the built-in carriers');
}

export { handler } from '../../../src/auth/pre-token-generation.ts';
