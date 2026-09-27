/**
 * ---------------------------------------------------------------------------
 * One AgentCore invocation: token in, answer out
 * ---------------------------------------------------------------------------
 * What runs behind `POST /invocations` in the AgentCore Runtime microVM. The
 * HTTP server around it (infra/terraform/agentcore/agent-entry.ts) is Node
 * only; THIS is portable and tested - the same agent loop, tools and
 * guardrails the board runs in the tab.
 *
 * THE TOKEN IS CHECKED TWICE, on purpose - the board API's rule, restated.
 * AgentCore Identity's JWT authorizer validates signature, issuer, expiry and
 * `client_id` BEFORE the request reaches this microVM, and rejects the rest
 * without starting anything. It does not check `token_use` (an ID token from
 * the same pool passes it) or that a tenant claim exists - and the tenant
 * claim is the boundary every tool derives its keys from. So the forwarded
 * `Authorization` header (allowlisted in Terraform: AgentCore passes no header
 * it was not told to) is verified again here with all seven checks.
 *
 * FOLLOW-UPS, FROM THE SESSION'S OWN MEMORY. AgentCore sends every request
 * with the same session id to the same warm microVM and wipes it when the
 * session ends, so a conversation kept in a module-level map lives exactly
 * as long as the session - "and what is above it?" works, and nothing
 * outlives the idle timeout. No database, no AgentCore Memory, no cost.
 * Keyed by the VERIFIED user, not the session: AgentCore does not bind a
 * session to a user, and anyone authorised who sent another person's
 * session id would land in their microVM - where they would find their own
 * history, and nobody else's.
 *
 * READ-ONLY. The deployed agent is offered the read tools only, and the loop
 * refuses any tool it did not offer. Opening an incident pages a human; a
 * model in the cloud doing that is a decision, like writing Helix tickets,
 * and the runtime's IAM role cannot write the table anyway.
 */
import type { Principal } from '../platform/types.ts';
import { log } from '../platform/logger.ts';
import { loadEstate } from '../geo/device-repository.ts';
import { seedDemoWorld } from '../api/board-api.ts';
import { knowledgeBase } from './knowledge-base.ts';
import { runAgent, type AgentResult } from './agent-core.ts';
import { toolSpecsFor } from './tools.ts';
import { redactPii } from './guardrails.ts';

export type InvocationRequest = {
  /** The `Authorization` header, as AgentCore forwarded it. */
  authorization: string | undefined;
  /** The raw request body: `{"question": "...", "newConversation"?: true}`. */
  body: string;
};

export type InvocationResponse = { status: number; body: AgentResult | { error: string } };

export type InvocationDeps = {
  /** Access token -> Principal, or throw. In AgentCore: RS256 against the pool's JWKS. */
  verify: (token: string) => Promise<Principal>;
};

/** A question longer than this is not a question an operator typed. */
export const MAX_QUESTION_CHARS = 2000;

/**
 * The knowledge base is per microVM and filled once per tenant. A session's
 * microVM serves many invocations; re-ingesting every time would duplicate
 * every chunk and double every retrieval score.
 */
const ingested = new Set<string>();

/** How much of a conversation the agent carries into the next question. */
export const HISTORY_TURNS = 4;
/** Per stored answer. An answer can quote a page of tool output; the gist is enough context. */
export const HISTORY_ANSWER_CHARS = 1500;

type Turn = { question: string; answer: string };
const conversations = new Map<string, Turn[]>();
const conversationKey = (p: Principal) => p.tenantId + '|' + p.sub;

export async function handleAgentInvocation(req: InvocationRequest, deps: InvocationDeps): Promise<InvocationResponse> {
  const header = req.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    // AgentCore already authorised this request, so a missing header here is
    // not an attacker - it is `request_header_allowlist` not including
    // Authorization. Say THAT in the log; the caller gets the plain 401.
    log.warn('agent: no bearer token reached the agent - is Authorization in request_header_allowlist?');
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  let principal: Principal;
  try {
    principal = await deps.verify(header.slice('Bearer '.length));
  } catch (err) {
    log.warn('agent: token rejected', { reason: err instanceof Error ? err.message : String(err) });
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  let question: string;
  let fresh = false;
  try {
    const parsed = JSON.parse(req.body) as { question?: unknown; newConversation?: unknown };
    if (typeof parsed.question !== 'string' || !parsed.question.trim()) throw new Error('missing');
    question = parsed.question.trim();
    fresh = parsed.newConversation === true;
  } catch {
    return { status: 400, body: { error: 'Send {"question": "..."}.' } };
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return { status: 400, body: { error: 'Questions are limited to ' + MAX_QUESTION_CHARS + ' characters.' } };
  }

  try {
    // The world the tools compute in - device ids, scenario ids - seeded as
    // the board and the seed script do, so the agent and the board describe
    // the same estate. Per invocation, for the reason board-api.ts gives.
    seedDemoWorld();
    loadEstate(principal.tenantId);
    if (!ingested.has(principal.tenantId)) {
      await knowledgeBase.ingestRunbooks(principal.tenantId);
      ingested.add(principal.tenantId);
    }

    const key = conversationKey(principal);
    if (fresh) conversations.delete(key);
    const history = conversations.get(key) ?? [];

    const result = await runAgent({
      question,
      // The CALLER's principal - never a privileged one. A Dallas operator's
      // assistant sees Dallas, because the tools derive keys from this.
      principal,
      tools: toolSpecsFor(principal, { readOnly: true }),
      history,
    });

    // Only answers that passed the output guardrail become context - a
    // withheld answer fed back in would be the model reading what it was
    // not allowed to say. Questions are stored as the model saw them: PII
    // redacted.
    if (result.stoppedBecause === 'end_turn') {
      conversations.set(key, [...history, {
        question: redactPii(question),
        answer: result.answer.slice(0, HISTORY_ANSWER_CHARS),
      }].slice(-HISTORY_TURNS));
    }
    log.info('agent: answered', {
      tenant: principal.tenantId, stoppedBecause: result.stoppedBecause,
      modelCalls: result.usage.modelCalls, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
    });
    return { status: 200, body: result };
  } catch (err) {
    // Detail to the log (CloudWatch, via AgentCore), never to the caller.
    log.error('agent: invocation failed', { error: err instanceof Error ? err.message : String(err) });
    return { status: 500, body: { error: 'The assistant failed. Try again.' } };
  }
}
