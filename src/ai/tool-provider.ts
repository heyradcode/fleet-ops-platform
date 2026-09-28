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
import { recordToolCall, type AuditOutcome, type AuditVia } from './audit.ts';
import { wallNow } from '../platform/clock.ts';

export type ToolProvider = {
  /** Which kind - reported with the answer, so the board can say "tools over MCP". */
  readonly via: 'in-process' | 'mcp';
  /**
   * How an MCP provider reaches its server: straight to the runtime, or
   * through the AgentCore Gateway in front of it. Reported with the answer,
   * so "via Gateway" on the board is proof the front door is in the path
   * rather than a claim in a Terraform file.
   */
  readonly route?: 'direct' | 'gateway';
  /** The tools this caller may be offered. Computed from the caller, never global. */
  list(): Promise<ToolSpec[]>;
  /** Run one. Errors come back as text starting "ERROR:" - never thrown at the loop. */
  call(name: string, input: Record<string, unknown>): Promise<string>;
};

/**
 * The knowledge base is per process and filled once per tenant. Re-ingesting
 * would duplicate every chunk and double every retrieval score. The PROMISE
 * is kept, not a flag set after it: two first requests arriving together both
 * saw "not yet" and both ingested - 50 chunks where there should be 25.
 */
const ingesting = new Map<string, Promise<void>>();

/**
 * The world the tools compute in - device ids, scenario ids - seeded as the
 * board and the seed script do, so every tool describes the same estate the
 * board shows. Per call, for the reason board-api.ts gives (a warm process
 * would otherwise carry one tenant's random state into the next).
 */
export async function prepareToolWorld(principal: Principal): Promise<void> {
  seedDemoWorld();
  loadEstate(principal.tenantId);
  let done = ingesting.get(principal.tenantId);
  if (!done) {
    done = knowledgeBase.ingestRunbooks(principal.tenantId).then(() => undefined);
    ingesting.set(principal.tenantId, done);
    // A failed ingestion is retried by the next request, not cached forever.
    void done.catch(() => { ingesting.delete(principal.tenantId); });
  }
  await done;
}

/** What running a tool produced, and how it went - the audit's outcome, decided HERE. */
export type ToolRun = { text: string; outcome: AuditOutcome };

/**
 * Run one tool as `principal`: the role check, then the tool, with any throw
 * turned into text. The ONE implementation - the in-process provider, the tab
 * and the MCP server all come through here.
 *
 * The outcome is classified at the point that KNOWS: "refused" is the role
 * check saying no, which a caller holding only the text could not tell apart
 * from a tool failing - and an audit that files a refusal under "error" hides
 * the one row an admin reviewing it is looking for.
 */
export async function runToolAs(name: string, input: Record<string, unknown>, principal: Principal): Promise<ToolRun> {
  const tool = toolByName(name);
  if (!tool) return { text: 'ERROR: no such tool "' + name + '".', outcome: 'refused' };

  // Authorisation belongs HERE, not in the prompt and not only in the caller:
  // a viewer cannot page anyone however the model was talked into it.
  const verdict = canUseTool(principal, name);
  if (!verdict.allowed) return { text: 'ERROR: ' + verdict.reason, outcome: 'refused' };

  try {
    const text = await tool.execute(input, principal);
    // A tool reports a bad argument ("unknown deviceId") by returning ERROR:
    // text rather than throwing, so the model can correct itself. Still an error.
    return { text, outcome: text.startsWith('ERROR:') ? 'error' : 'ok' };
  } catch (err) {
    // Never let a tool exception kill the turn - hand the model the problem.
    return { text: 'ERROR: ' + (err instanceof Error ? err.message : String(err)), outcome: 'error' };
  }
}

/** `runToolAs`, text only - what the model reads. */
export async function runTool(name: string, input: Record<string, unknown>, principal: Principal): Promise<string> {
  return (await runToolAs(name, input, principal)).text;
}

/**
 * Run and RECORD. Where a call is audited it goes through here, so the MCP
 * server and the tab's demonstration trail cannot record different things.
 * The clock is `wallNow()`, as the audit's is: how long a person waited is a
 * real duration, whatever the demo's pinned clock says.
 */
export async function runAudited(
  name: string,
  input: Record<string, unknown>,
  principal: Principal,
  via: AuditVia,
  audit: typeof recordToolCall = recordToolCall,
): Promise<ToolRun> {
  const started = wallNow();
  const run = await runToolAs(name, input, principal);
  await audit(principal, { tool: name, input, outcome: run.outcome, ms: wallNow() - started, via });
  return run;
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
