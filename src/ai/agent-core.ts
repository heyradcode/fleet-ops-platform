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
import { runTool } from './tool-provider.ts';
import { checkInput, checkOutput } from './guardrails.ts';
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
  stoppedBecause: 'end_turn' | 'max_iterations' | 'guardrail' | 'refusal' | 'max_tokens';
  usage: { modelCalls: number; inputTokens: number; outputTokens: number };
  /**
   * Where the answer was produced, for the person reading it: in the tab or
   * on AgentCore, by which model, and which turn of the conversation. Set by
   * the CALLER of runAgent - the loop does not know where it is running.
   */
  servedBy?: { host: 'tab' | 'agentcore'; model: string; turn: number; tools?: 'in-process' | 'mcp' };
};

const SYSTEM_PROMPT = [
  'You are NetPulse, an assistant for enterprise network operations.',
  'You are talking to an engineer who is watching a live board, often at 4am.',
  '',
  'Rules:',
  '- Ground every recommendation in a runbook you retrieved. If no runbook',
  '  covers the situation, say so rather than improvising a procedure.',
  '- Check observations before explaining a cause. Do not speculate from the',
  '  question alone.',
  '- Before blaming a device, trace the topology. A device that is merely',
  '  downstream of a failure is a symptom, and sending someone to the wrong',
  '  rack costs the first twenty minutes of an outage.',
  '- Say which OBSERVATION PLANES support your conclusion. Two reports from',
  '  one chassis are one witness, not two, and an answer that treats them as',
  '  corroboration is worse than one that admits the evidence is thin.',
  '- Never claim to have taken an action you did not take via a tool.',
].join('\n');

export async function runAgent(opts: {
  question: string;
  principal: Principal;
  tools: ToolSpec[];
  maxIterations?: number;
  /**
   * Earlier turns of this conversation, oldest first, as plain question /
   * answer text - never the tool calls or thinking blocks behind them, which
   * would grow every request and tie the history to one model. Where it is
   * kept, and for whom, is the caller's business: see agent-invocation.ts.
   */
  history?: Array<{ question: string; answer: string }>;
  /**
   * Called with each step AS IT HAPPENS - the same entries that end up in
   * `trace`. For streaming: the person watching sees the runbook lookup and
   * the observation query while the model is still thinking, rather than a
   * spinner and then everything at once.
   */
  onStep?: (step: AgentTrace) => void;
  /**
   * How to run a tool. Omitted: in this process (tool-provider.ts). The
   * deployed agent passes its MCP client's `call`, so every tool call
   * crosses to the MCP server with the user's token.
   */
  callTool?: (name: string, input: Record<string, unknown>) => Promise<string>;
}): Promise<AgentResult> {
  // The budget has to leave room for a FINAL ANSWER after the tools, so it is
  // one more than the number of tools the agent might reasonably chain. Set it
  // too low and the agent stops mid-investigation with nothing to show; too
  // high and a confused loop burns tokens before anyone notices.
  //
  // This bit us once already: adding a sixth tool made a budget of 6 too small,
  // and the failure looked like the model misbehaving rather than a budget the
  // tool count had outgrown. It bit a second time when the comms and ITSM
  // tools arrived: an HHS caller is offered 10-12 tools against a fixed 8, and
  // the first question ever asked of the AgentCore agent ended "could not
  // reach a conclusion within 8 steps". So the default GROWS with the tools
  // offered - one step each, one for the answer, one spare - and never drops
  // below 8. An explicit maxIterations still wins.
  const maxIterations = opts.maxIterations ?? Math.max(8, opts.tools.length + 2);
  const trace: AgentTrace[] = [];
  const record = (entry: AgentTrace) => { trace.push(entry); opts.onStep?.(entry); };
  const evidence: string[] = [];
  let step = 0;

  // ---- Input guardrail ---------------------------------------------------
  const t0 = performance.now();
  const inputCheck = checkInput(opts.question);
  record({
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

  const messages: Message[] = [
    ...(opts.history ?? []).flatMap((turn): Message[] => [
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.answer },
    ]),
    { role: 'user', content: inputCheck.redactedText ?? opts.question },
  ];
  const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };

  // ---- The loop ----------------------------------------------------------
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const modelStart = performance.now();
    const response = await invokeModel({ system: SYSTEM_PROMPT, messages, tools: opts.tools, maxTokens: 16000 });

    usage.modelCalls++;
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;

    record({
      step: ++step, kind: 'model',
      detail: 'stop_reason=' + response.stop_reason + ' blocks=' + response.content.length,
      ms: Math.round(performance.now() - modelStart),
    });

    // The assistant turn must be appended VERBATIM, tool_use blocks included.
    // Dropping them breaks the tool_use_id linkage on the next request.
    messages.push({ role: 'assistant', content: response.content });

    // A REAL model can stop for reasons the scripted one never does. A
    // refusal may come back with no text at all, and returning that as the
    // answer would show the engineer a blank panel - say what happened.
    if (response.stop_reason === 'refusal') {
      return {
        answer: 'The model declined to answer this request. Rephrase it, or ask about a specific device or incident.',
        trace, evidence, stoppedBecause: 'refusal', usage,
      };
    }
    if (response.stop_reason === 'max_tokens') {
      return {
        answer: 'The answer was cut off at the output limit. Here is what the tools returned:\n' + evidence.join('\n---\n'),
        trace, evidence, stoppedBecause: 'max_tokens', usage,
      };
    }

    if (response.stop_reason !== 'tool_use') {
      const answer = response.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      // ---- Output guardrail ----
      const outCheck = checkOutput(answer, evidence);
      record({
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
        const content = await executeTool(use.name, use.input, opts.principal, opts.tools, opts.callTool);
        const isError = content.startsWith('ERROR:');

        record({
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

/**
 * Tool dispatch. The OFFERED check is the loop's own; everything after it -
 * the role check, the tool, error containment - is the provider's
 * (tool-provider.ts `runTool`, which the MCP server also calls).
 */
async function executeTool(
  name: string,
  input: Record<string, unknown>,
  principal: Principal,
  offered: ToolSpec[],
  callTool?: (name: string, input: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  // Only what this run OFFERED. A model can name a tool it was never shown -
  // a real one more readily than the scripted one - and a read-only run whose
  // loop still dispatched openIncident would be read-only in the prompt only.
  // Kept here even when the tools are behind MCP: defence in depth.
  if (!offered.some((t) => t.name === name)) return 'ERROR: tool "' + name + '" is not available in this session.';
  try {
    return callTool ? await callTool(name, input) : await runTool(name, input, principal);
  } catch (err) {
    // A provider that throws (an MCP server unreachable) is still a tool
    // result to the model, never the end of the turn.
    return 'ERROR: ' + (err instanceof Error ? err.message : String(err));
  }
}
