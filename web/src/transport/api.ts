/**
 * The API transport: the board's two data views over HTTP, from the real
 * table, with the Cognito access token on every request.
 *
 *   GET {VITE_BOARD_API_URL}/board?siteId=   the network view
 *   GET {VITE_BOARD_API_URL}/comms           the comms view
 *
 * Served by src/api/board-api.ts in Lambda - the SAME functions the
 * in-process transport calls in the tab, so switching transports changes
 * where the answer is computed, never what it is.
 *
 * Everything else DELEGATES to the in-process transport: the health replay
 * and the live alarm feed play back recorded scenarios, and the assistant
 * runs on the offline Bedrock stand-in. None of them has data behind it to
 * fetch; see the header of board-api.ts.
 *
 * THE TOKEN, NOT THE PRINCIPAL, is what goes over the wire. The principal
 * the board holds is for rendering; the API derives its own from the token,
 * and what the board believes about its scope is never sent to be trusted.
 */
import type { Transport } from './index.ts';
import { inProcessTransport } from './in-process.ts';

export function boardApiUrl(): string | undefined {
  const url = import.meta.env?.VITE_BOARD_API_URL as string | undefined;
  return url ? url.replace(/\/+$/, '') : undefined;
}

/**
 * A failed API call, with a message fit to show the person at the board.
 * `status` 401 means the token is no longer accepted - the shell sends the
 * person back to sign-in rather than leaving a board that cannot load.
 */
export class BoardApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BoardApiError';
    this.status = status;
  }
}

/**
 * A transport against one API. `fetch` is injected so the tests can wire it
 * straight into the Lambda handler and prove the two agree on the wire.
 */
export function createApiTransport(base: string | undefined, fetchImpl: typeof fetch = (...a) => fetch(...a)): Transport {
  let token: string | null = null;

  async function get<T>(path: string): Promise<T> {
    if (!base) throw new BoardApiError('The board API is not configured for this build.');
    if (!token) throw new BoardApiError('No session. The board must not load before sign-in.');

    let res: Response;
    try {
      res = await fetchImpl(base + path, {
        headers: { authorization: 'Bearer ' + token },
        // The API sends no cookies and wants none; 'omit' keeps it that way
        // even if a future cookie lands on the API's domain.
        credentials: 'omit',
      });
    } catch {
      // A network failure and a CORS refusal look identical from here: the
      // browser hides the difference on purpose.
      throw new BoardApiError('The board API did not answer - check the network, or that this origin is allowed.');
    }
    // An access token lives an hour (the pool's access_token_validity).
    if (res.status === 401) throw new BoardApiError('Your session has expired - sign in again.', 401);
    if (res.status === 403) throw new BoardApiError('That is outside what your account can see.');
    if (res.status === 429) throw new BoardApiError('The board API is busy - try again in a moment.');
    if (!res.ok) throw new BoardApiError('The board API failed (' + res.status + ').');
    return await res.json() as T;
  }

  return {
    setSession(principal, accessToken) {
      token = accessToken ?? null;
      // The delegated parts - replay, live feed, assistant - still scope by it.
      inProcessTransport.setSession(principal);
    },

    loadBoard(siteId) {
      return get('/board' + (siteId ? '?siteId=' + encodeURIComponent(siteId) : ''));
    },

    loadComms() {
      return get('/comms');
    },

    subscribeHealth: (siteId, onTick) => inProcessTransport.subscribeHealth(siteId, onTick),
    subscribeAlarms: (siteId, onAlarm) => inProcessTransport.subscribeAlarms(siteId, onAlarm),
    askAgent: (question, onStep) => inProcessTransport.askAgent(question, onStep),
  };
}

export const apiTransport: Transport = createApiTransport(boardApiUrl());
