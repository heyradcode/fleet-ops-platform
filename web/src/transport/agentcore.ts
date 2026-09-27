/**
 * The assistant on Amazon Bedrock AgentCore - called straight from the tab.
 *
 *   POST https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{ARN}/invocations?qualifier=DEFAULT
 *   Authorization: Bearer <the Cognito ACCESS token the board signed in with>
 *   X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <this tab's session>
 *
 * DIRECTLY, not through the board API. The AgentCore endpoint answers CORS
 * for any origin, and AgentCore Identity validates the token itself - a
 * proxy Lambda would add a hop, a 30-second API Gateway ceiling on a
 * multi-step answer, and nothing else. No AWS credentials are involved: the
 * runtime is configured for JWT inbound auth, which is the point.
 *
 * THE SESSION ID PICKS THE microVM. AgentCore routes every request with the
 * same id to the same isolated microVM, warm, and starts a new one for a new
 * id. So: one per tab, NEW whenever the token changes - one person's session
 * must never be handed to the next person who signs in at the same desk -
 * and random from the platform CSPRNG directly, not `uuid()`, which the demo
 * world deliberately seeds and would hand every tab the same session.
 */
import type { AgentResult } from './index.ts';
import { BoardApiError } from './api.ts';

export function agentRuntimeArn(): string | undefined {
  const arn = import.meta.env?.VITE_AGENT_RUNTIME_ARN as string | undefined;
  return arn || undefined;
}

/** The runtime's invocation URL. The region is the ARN's fourth field. */
export function invocationUrl(arn: string): string {
  const region = arn.split(':')[3];
  if (!arn.startsWith('arn:aws:bedrock-agentcore:') || !region) {
    throw new Error('VITE_AGENT_RUNTIME_ARN is not an AgentCore runtime ARN: ' + arn);
  }
  return 'https://bedrock-agentcore.' + region + '.amazonaws.com/runtimes/' +
    encodeURIComponent(arn) + '/invocations?qualifier=DEFAULT';
}

/** 48 hex characters: AgentCore wants a session id of at least 33. */
function newSessionId(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return 'netpulse-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type AgentCoreAsker = {
  setToken(token: string | null): void;
  ask(question: string): Promise<AgentResult>;
  /** For tests and the trace: which microVM this tab is talking to. */
  readonly sessionId: string;
};

/**
 * While AgentCore is provisioning or tearing down a session's microVM, a
 * second request to it gets 409 RetryableConflictException. The AWS SDKs
 * retry that on their own; a bare fetch does not, so this does - briefly,
 * because the window is the time it takes to start a microVM.
 */
const CONFLICT_RETRIES_MS = [250, 500, 1000, 2000];

export function createAgentCoreAsker(
  arn: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  makeSessionId: () => string = newSessionId,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): AgentCoreAsker {
  const url = invocationUrl(arn);
  let token: string | null = null;
  let sessionId = makeSessionId();

  return {
    get sessionId() { return sessionId; },

    setToken(next) {
      if (next !== token) sessionId = makeSessionId();
      token = next;
    },

    async ask(question) {
      if (!token) throw new BoardApiError('No session. Sign in first.');
      const send = () => fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'x-amzn-bedrock-agentcore-runtime-session-id': sessionId,
        },
        body: JSON.stringify({ question }),
        credentials: 'omit',
      });
      let res: Response;
      try {
        res = await send();
        for (const wait of CONFLICT_RETRIES_MS) {
          const retryable = res.status === 409 && (res.headers.get('x-amzn-errortype') ?? '').startsWith('RetryableConflict');
          if (!retryable) break;
          await sleep(wait);
          res = await send();
        }
      } catch {
        throw new BoardApiError('The assistant did not answer - check the network.');
      }
      if (res.ok) return await res.json() as AgentResult;

      // AgentCore names the failure in x-amzn-ErrorType; the agent's own
      // errors arrive wrapped as a 424 RuntimeClientError.
      const kind = res.headers.get('x-amzn-errortype') ?? '';
      if (res.status === 401) throw new BoardApiError('Your session has expired - sign in again.', 401);
      if (res.status === 429 || kind.startsWith('Throttling')) throw new BoardApiError('The assistant is busy - try again in a moment.', 429);
      if (res.status === 409) throw new BoardApiError('The assistant is still starting up - ask again in a moment.', 409);
      if (res.status === 424) throw new BoardApiError('The assistant failed on this question. Try rephrasing it.', 424);
      if (res.status === 403) throw new BoardApiError('The assistant refused this account (' + (kind || 'AccessDenied') + ').', 403);
      throw new BoardApiError('The assistant failed (' + res.status + (kind ? ' ' + kind : '') + ').', res.status);
    },
  };
}
