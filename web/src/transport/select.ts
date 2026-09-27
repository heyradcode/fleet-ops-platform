/**
 * Which transport this build uses. Decisions made once, from config.
 *
 *   VITE_BOARD_API_URL set      -> the network and comms views over HTTP,
 *                                  from the real table (the board API)
 *   otherwise                   -> computed in the tab, from the in-memory store
 *
 *   VITE_AGENT_RUNTIME_ARN set  -> the assistant runs on Amazon Bedrock
 *                                  AgentCore, called straight from the tab
 *   otherwise                   -> the assistant runs in the tab
 *
 * Independent on purpose: each can be switched on and checked on its own.
 * Sign-in is the real pool either way (auth/provider.ts), so both remote
 * paths get a token they can verify.
 */
import type { Transport } from './index.ts';
import { inProcessTransport } from './in-process.ts';
import { apiTransport, boardApiUrl } from './api.ts';
import { agentRuntimeArn, createAgentCoreAsker } from './agentcore.ts';

export const usingBoardApi = Boolean(boardApiUrl());

const base: Transport = usingBoardApi ? apiTransport : inProcessTransport;

const arn = agentRuntimeArn();
const asker = arn ? createAgentCoreAsker(arn) : undefined;

export const usingAgentCore = Boolean(asker);

export const transport: Transport = asker
  ? {
      ...base,
      setSession(principal, accessToken) {
        base.setSession(principal, accessToken);
        asker.setToken(accessToken ?? null);
      },
      askAgent: (question) => asker.ask(question),
      newConversation: () => asker.newConversation(),
    }
  : base;
