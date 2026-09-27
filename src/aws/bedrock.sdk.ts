/**
 * ---------------------------------------------------------------------------
 * Claude on Amazon Bedrock - the real model behind `invokeModel`
 * ---------------------------------------------------------------------------
 * NODE ONLY, like dynamodb.sdk.ts: it loads `@anthropic-ai/bedrock-sdk`, and
 * nothing the browser loads may import it. Registered with `setModelInvoker`
 * by the AgentCore entry point (infra/terraform/agentcore/agent-entry.ts).
 *
 * `AnthropicBedrockMantle` is the Messages API on Bedrock's own endpoint
 * (`https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`): the SAME
 * request and response shape as Anthropic's first-party API - tools,
 * tool_use / tool_result, stop_reason - signed with SigV4 from the ambient AWS
 * credentials. Inside AgentCore that is the runtime's execution role, which
 * needs `bedrock-mantle:CreateInference`. Model ids carry an `anthropic.`
 * prefix: `anthropic.claude-opus-5`.
 *
 * TWO THINGS A REAL MODEL DOES THAT THE SCRIPTED ONE DOES NOT:
 *
 *   It THINKS. Current Claude models run adaptive thinking by default and
 *   return `thinking` blocks, which must go back unchanged on the next turn.
 *   agent-core appends the assistant turn verbatim; this adapter passes the
 *   content through untouched and never strips or rewrites a block.
 *
 *   It can REFUSE. A safety classifier may decline (HTTP 200, stop_reason
 *   "refusal"). Bedrock does not offer the first-party server-side `fallbacks`
 *   parameter, so the fallback is client-side: the same request, once, on
 *   `fallbackModel`. Thinking blocks from the first model are simply ignored
 *   by the second - nothing to strip.
 */
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type { ContentBlock, ModelInvoker, ModelRequest, ModelResponse } from './bedrock.ts';
import { log } from '../platform/logger.ts';

/** The one method this adapter uses. Injected in tests, so they need no AWS. */
export type MessagesClient = {
  messages: { create(body: Record<string, unknown>): Promise<unknown> };
};

type RawResponse = {
  stop_reason: ModelResponse['stop_reason'] | null;
  content: unknown[];
  usage: { input_tokens: number; output_tokens: number };
};

export type ClaudeInvokerOptions = {
  /** e.g. `anthropic.claude-opus-5`. */
  model: string;
  /** Tried once, on the same request, when `model` refuses. Omit to disable. */
  fallbackModel?: string;
  /** Defaults to AWS_REGION. */
  region?: string;
  client?: MessagesClient;
};

export function createClaudeInvoker(opts: ClaudeInvokerOptions): ModelInvoker {
  // At creation, not per call: the client keeps its connections and resolved
  // credentials across invocations of a warm AgentCore session.
  const client: MessagesClient = opts.client
    ?? (new AnthropicBedrockMantle({ awsRegion: opts.region }) as unknown as MessagesClient);

  const call = async (model: string, req: ModelRequest): Promise<ModelResponse> => {
    const raw = await client.messages.create({
      model,
      // 16k is the non-streaming ceiling worth using: a larger max_tokens on a
      // non-streaming call risks the SDK's HTTP timeout. Each loop turn is a
      // tool call or a short answer; nowhere near it.
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: req.messages,
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    }) as RawResponse;
    return {
      // null only on a streaming partial, which this never is.
      stop_reason: raw.stop_reason ?? 'end_turn',
      // Passed through as-is - thinking blocks included. See the header.
      content: raw.content as ContentBlock[],
      usage: { input_tokens: raw.usage.input_tokens, output_tokens: raw.usage.output_tokens },
    };
  };

  return async (req) => {
    const first = await call(opts.model, req);
    if (first.stop_reason !== 'refusal' || !opts.fallbackModel) return first;
    log.warn('model refused - retrying once on the fallback model', { model: opts.model, fallback: opts.fallbackModel });
    const second = await call(opts.fallbackModel, req);
    return {
      ...second,
      // Both calls were billed; the usage the agent reports should say so.
      usage: {
        input_tokens: first.usage.input_tokens + second.usage.input_tokens,
        output_tokens: first.usage.output_tokens + second.usage.output_tokens,
      },
    };
  };
}
