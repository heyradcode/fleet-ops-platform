/**
 * Which transport this build uses. One decision, made once, from config -
 * the same shape as auth/provider.ts, and dependent on it.
 *
 *   VITE_BOARD_API_URL set, and signed in through Cognito  -> the API
 *   otherwise                                              -> in the tab
 *
 * The API needs COGNITO sign-in, not just its URL: it accepts only an access
 * token from the real pool, and the offline issuer's tokens are signed with a
 * demo key it has never heard of. A build with the URL but not Cognito would
 * answer every request with 401 and look like a broken API, so it says why
 * once, and stays in the tab.
 */
import type { Transport } from './index.ts';
import { inProcessTransport } from './in-process.ts';
import { apiTransport, boardApiUrl } from './api.ts';
import { usingCognito } from '../auth/provider.ts';

export const usingBoardApi = Boolean(boardApiUrl()) && usingCognito;

if (boardApiUrl() && !usingCognito) {
  console.warn('VITE_BOARD_API_URL is set but Cognito is not - the API only accepts the real pool\'s ' +
    'tokens, so the board is computing in the tab. See infra/terraform/auth/README.md.');
}

export const transport: Transport = usingBoardApi ? apiTransport : inProcessTransport;
