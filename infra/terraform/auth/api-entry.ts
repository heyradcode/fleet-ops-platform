/**
 * The board API Lambda's entry point.
 *
 * Same reason as lambda-entry.ts: the handler (src/api/board-api.ts) is in
 * the BROWSER's module graph - the in-process transport calls the same
 * snapshot functions - so the SDK adapter is wired here, in a file only
 * esbuild reads, and never inside anything the board loads.
 *
 * At MODULE scope, once per cold start: the DynamoDB client keeps its
 * connections and credentials across invocations, and the verifier's JWKS
 * cache (auth/cognito-jwt-verifier.ts) keeps the pool's keys - one fetch per
 * container, not one per request.
 *
 * FAILS AT COLD START when misconfigured, not per request. Terraform sets all
 * three; one missing is a broken deployment, and a function that started
 * anyway would answer every request with a 401 or a 500 that points at the
 * token or the table rather than at the missing variable.
 */
import { setTableStore } from '../../../src/aws/dynamodb.ts';
import { createSdkTableStore } from '../../../src/aws/dynamodb.sdk.ts';
import { verifyTokenRs256 } from '../../../src/auth/cognito-jwt-verifier.ts';
import { handleBoardApi } from '../../../src/api/board-api.ts';
import type { ApiGatewayEvent } from '../../../src/api/rest-handler.ts';
import { env } from '../../../src/platform/env.ts';

const table = env('TABLE_NAME', '');
const issuer = env('COGNITO_ISSUER', '');
const clientId = env('COGNITO_APP_CLIENT_ID', '');

const missing = Object.entries({ TABLE_NAME: table, COGNITO_ISSUER: issuer, COGNITO_APP_CLIENT_ID: clientId })
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) throw new Error('board api: missing ' + missing.join(', ') + ' - check the Terraform environment block');

setTableStore(createSdkTableStore(table));

export const handler = (event: ApiGatewayEvent) =>
  handleBoardApi(event, { verify: (token) => verifyTokenRs256(token, { issuer, clientId }) });
