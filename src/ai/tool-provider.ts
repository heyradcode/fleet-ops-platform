/**
 * ---------------------------------------------------------------------------
 * Where the agent's tools come from: in-process, or an MCP server
 * ---------------------------------------------------------------------------
 * The agent loop (agent-core.ts) asks a ToolProvider two things - "what tools
 * may this run offer?" and "run this one" - and never learns whether the answer
 * came from a function in the same process or from an MCP server on another
 * AgentCore runtime. The tab and the tests use the in-process provider; the
 * deployed agent uses the MCP client (mcp/client.ts), which reaches the MCP
 * server (mcp/server.ts) with the SAME user token it was invoked with.
 *
 * WHAT STAYS THE SAME EITHER WAY, and why that matters: the tool functions,
 * the role check and error-as-data live HERE, in `runTool`, and the MCP
 * server calls exactly this function. So "the agent over MCP" and "the agent
 * in the tab" cannot disagree about what a tool does or who may call it.
 */
import type { ToolSpec } from '../aws/bedrock.ts';
import type { Principal } from '../platform/types.ts';
import { loadEstate } from '../geo/device-repository.ts';
import { seedDemoWorld } from '../api/board-api.ts';
import { knowledgeBase } from './knowledge-base.ts';
import { toolByName, toolSpecsFor } from './tools.ts';
import { canUseTool } from './guardrails.ts';

export type ToolProvider = {
  /** Which kind - reported with the answer, so the board can say "tools over MCP". */
  readonly via: 'in-process' | 'mcp';
  /** The tools this caller may be offered. Computed from the caller, never global. */
  list(): Promise<ToolSpec[]>;
  /** Run one. Errors come back as text starting "ERROR:" - never thrown at the loop. */
  call(name: string, input: Record<string, unknown>): Promise<string>;
};

/**
 * The knowledge base is per process and filled once per tenant. Re-ingesting
 * would duplicate every chunk and double every retrieval score.
 */
const ingested = new Set<string>();

/**
 * The world the tools compute in - device ids, scenario ids - seeded as the
 * board and the seed script do, so every tool describes the same estate the
 * board shows. Per call, for the reason board-api.ts gives (a warm process
 * would otherwise carry one tenant's random state into the next).
 */
export async function prepareToolWorld(principal: Principal): Promise<void> {
  seedDemoWorld();
  loadEstate(principal.tenantId);
  if (!ingested.has(principal.tenantId)) {
    await knowledgeBase.ingestRunbooks(principal.tenantId);
    ingested.add(principal.tenantId);
  }
}

/**
 * Run one tool as `principal`: the role check, then the tool, with any throw
 * turned into text. The ONE implementation - the in-process provider and the
 * MCP server both call it.
 */
export async function runTool(name: string, input: Record<string, unknown>, principal: Principal): Promise<string> {
  const tool = toolByName(name);
  if (!tool) return 'ERROR: no such tool "' + name + '".';

  // Authorisation belongs HERE, not in the prompt and not only in the caller:
  // a viewer cannot page anyone however the model was talked into it.
  const verdict = canUseTool(principal, name);
  if (!verdict.allowed) return 'ERROR: ' + verdict.reason;

  try {
    return await tool.execute(input, principal);
  } catch (err) {
    // Never let a tool exception kill the turn - hand the model the problem.
    return 'ERROR: ' + (err instanceof Error ? err.message : String(err));
  }
}

/** The tools in this process, as `principal`. */
export function inProcessTools(principal: Principal, opts: { readOnly: boolean }): ToolProvider {
  return {
    via: 'in-process',
    async list() {
      await prepareToolWorld(principal);
      return toolSpecsFor(principal, opts);
    },
    call: (name, input) => runTool(name, input, principal),
  };
}
