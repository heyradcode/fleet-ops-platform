/**
 * ---------------------------------------------------------------------------
 * The agent loop - what AWS AgentCore runs for you
 * ---------------------------------------------------------------------------
 * Amazon Bedrock AgentCore is the managed runtime for agents: it hosts the
 * loop, gives each session an isolated microVM, handles identity delegation,
 * short- and long-term memory, an MCP/Gateway layer that turns your existing
 * APIs into tools, and observability. You define the agent and its tools and
 * AgentCore does the turning of the crank.
 *
 * The crank is THIS, and it is worth being able to draw on a whiteboard:
 *
 *      user question
 *            |
 *            v
 *   +--> invoke model with (system, messages, tools)
 *   |        |
 *   |        +-- stop_reason 'end_turn'  --> done, return the text
 *   |        |
 *   |        +-- stop_reason 'tool_use'  --> execute the tool(s)
 *   |                    |
 *   |                    v
 *   +---------- append tool_result to messages
 *
 * That is the entire idea. Everything else - AgentCore, LangGraph, CrewAI - is
 * scaffolding around this loop: state, retries, memory, isolation, tracing.
 *
 * The four things that make it production-grade rather than a toy, all present
 * below:
 *   1. A hard iteration cap. A model that keeps calling tools will otherwise
 *      spend your money until the Lambda times out.
 *   2. Per-tool authorisation on every call, against the CALLER's principal.
 *   3. Errors returned as tool_result content, so the model can self-correct.
 *   4. A trace of every step, for debugging and for showing the user WHY.
 */
import { invokeModel, type ContentBlock, type Message, type ToolSpec } from '../aws/bedrock.ts';
import type { Principal } from '../platform/types.ts';
import { toolByName } from './tools.ts';
import { canUseTool, checkInput, checkOutput } from './guardrails.ts';
import { log } from '../platform/logger.ts';

export type AgentTrace = {
  step: number;
  kind: 'model' | 'tool' | 'guardrail';
  detail: string;
  ms: number;
};

export type AgentResult = {
  answer: string;
  trace: AgentTrace[];
  /** Everything the tools returned, so the caller can render citations. */
  evidence: string[];
  stoppedBecause: 'end_turn' | 'max_iterations' | 'guardrail';
  usage: { modelCalls: number; inputTokens: number; outputTokens: number };
};

const SYSTEM_PROMPT = [
  'You are Meridian, an operations assistant for enterprise network and',
  'contact-centre teams.',
  '',
  'Rules:',
  '- Ground every recommendation in a runbook you retrieved. If no runbook',
  '  covers the situation, say so rather than improvising a procedure.',
  '- Check telemetry before explaining a cause. Do not speculate from the',
  '  question alone.',
  '- Before claiming a problem is regional, verify it with a spatial query.',
  '- Cite the site ids and providers your conclusion rests on.',
  '- Never claim to have taken an action you did not take via a tool.',
].join('\n');

export async function runAgent(opts: {
  question: string;
  principal: Principal;
  tools: ToolSpec[];
  maxIterations?: number;
}): Promise<AgentResult> {
  const maxIterations = opts.maxIterations ?? 6;
  const trace: AgentTrace[] = [];
  const evidence: string[] = [];
  let step = 0;

  // ---- Input guardrail ---------------------------------------------------
  const t0 = performance.now();
  const inputCheck = checkInput(opts.question);
  trace.push({
    step: ++step, kind: 'guardrail',
    detail: inputCheck.allowed ? 'input allowed (PII redacted)' : 'input BLOCKED: ' + inputCheck.reason,
    ms: Math.round(performance.now() - t0),
  });
  if (!inputCheck.allowed) {
    return {
      answer: 'I cannot help with that: ' + inputCheck.reason,
      trace, evidence, stoppedBecause: 'guardrail',
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
    };
  }

  const messages: Message[] = [{ role: 'user', content: inputCheck.redactedText ?? opts.question }];
  const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };

  // ---- The loop ----------------------------------------------------------
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const modelStart = performance.now();
    const response = await invokeModel({ system: SYSTEM_PROMPT, messages, tools: opts.tools, maxTokens: 16000 });

    usage.modelCalls++;
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;

    trace.push({
      step: ++step, kind: 'model',
      detail: 'stop_reason=' + response.stop_reason + ' blocks=' + response.content.length,
      ms: Math.round(performance.now() - modelStart),
    });

    // The assistant turn must be appended VERBATIM, tool_use blocks included.
    // Dropping them breaks the tool_use_id linkage on the next request.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const answer = response.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      // ---- Output guardrail ----
      const outCheck = checkOutput(answer, evidence);
      trace.push({
        step: ++step, kind: 'guardrail',
        detail: outCheck.allowed ? 'output allowed (grounded)' : 'output BLOCKED: ' + outCheck.reason,
        ms: 0,
      });

      return {
        answer: outCheck.allowed ? outCheck.redactedText ?? answer : 'Answer withheld: ' + outCheck.reason,
        trace, evidence,
        stoppedBecause: outCheck.allowed ? 'end_turn' : 'guardrail',
        usage,
      };
    }

    // ---- Execute every tool_use block in this turn ------------------------
    // The model may emit several at once (parallel tool use). ALL of their
    // results must come back in ONE user message - splitting them across
    // messages teaches the model to stop calling tools in parallel.
    const toolUses = response.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );

    const results: ContentBlock[] = await Promise.all(
      toolUses.map(async (use) => {
        const toolStart = performance.now();
        const content = await executeTool(use.name, use.input, opts.principal);
        const isError = content.startsWith('ERROR:');

        trace.push({
          step: ++step, kind: 'tool',
          detail: use.name + '(' + JSON.stringify(use.input) + ')' + (isError ? ' -> error' : ''),
          ms: Math.round(performance.now() - toolStart),
        });
        if (!isError) evidence.push(content);

        return { type: 'tool_result', tool_use_id: use.id, content, is_error: isError } satisfies ContentBlock;
      }),
    );

    messages.push({ role: 'user', content: results });
  }

  log.warn('agent hit max iterations', { maxIterations });
  return {
    answer: 'I could not reach a conclusion within ' + maxIterations + ' steps. ' +
      'Here is what I gathered:\n' + evidence.join('\n---\n'),
    trace, evidence, stoppedBecause: 'max_iterations', usage,
  };
}

/** Tool dispatch with authorisation and error containment. */
async function executeTool(
  name: string,
  input: Record<string, unknown>,
  principal: Principal,
): Promise<string> {
  const tool = toolByName(name);
  if (!tool) return 'ERROR: no such tool "' + name + '".';

  const verdict = canUseTool(principal, name);
  if (!verdict.allowed) return 'ERROR: ' + verdict.reason;

  try {
    return await tool.execute(input, principal);
  } catch (err) {
    // Never let a tool exception kill the turn - hand the model the problem.
    return 'ERROR: ' + (err instanceof Error ? err.message : String(err));
  }
}
