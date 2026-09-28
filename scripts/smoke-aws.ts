/**
 * After a deploy: check the deployed path end to end, AS YOU.
 *
 *   NETPULSE_TOKEN=<your access token> pnpm smoke:aws
 *
 * Every piece that has to be applied in order - the board API, the knowledge
 * graph in DynamoDB, the Gateway, the MCP server behind it, the lock that
 * makes the Gateway the only way in, the agent pointed at it - checked with
 * the same token the board sends, and each FAIL naming the command that
 * fixes it. It replaces "ask the assistant something and tell me what it
 * said" with a list.
 *
 * YOUR TOKEN IS A CREDENTIAL. It is read from the environment, sent only to
 * the AgentCore and API Gateway hosts that already receive it from the board,
 * and never printed - the report shows who it says you are, decoded locally,
 * and how many minutes it has left. It lives an hour.
 *
 * Endpoints come from what the deploy already wrote: web/.env.cognito.local
 * (`pnpm web:env`) for the board API and the agent, and the agentcore root's
 * Terraform outputs for the Gateway and the MCP runtime. Nothing here writes
 * anything, anywhere - except the agent question, which the MCP server
 * audits like any other.
 *
 * Node only (process, child_process, fs): it lives in scripts/.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createMcpToolProvider, McpError } from '../src/ai/mcp/client.ts';
import { gatewayTargetUrl, runtimeInvocationUrl } from '../src/aws/agentcore-url.ts';
import {
  judgeAgent, judgeAudit, judgeBoard, judgeComms, judgeDirectRefused, judgeGatewayCall, judgeGatewayList,
  parseEnvFile, tokenSummary, type Check,
} from './smoke-checks.ts';

const token = process.env.NETPULSE_TOKEN?.trim() ?? '';
if (!token) {
  console.log([
    'NETPULSE_TOKEN is not set. It is your ACCESS token, from the board you are signed in to:',
    '',
    '  1. open the board and sign in',
    '  2. browser dev tools, Console:   copy(sessionStorage.getItem("netpulse.session"))',
    '  3. PowerShell:   $env:NETPULSE_TOKEN = "<paste>"',
    '     Git Bash:     export NETPULSE_TOKEN="<paste>"',
    '  4. pnpm smoke:aws',
    '',
    'It lives an hour, and this script never prints it.',
  ].join('\n'));
  process.exit(2);
}

let me: ReturnType<typeof tokenSummary>;
try {
  me = tokenSummary(token, Date.now());
} catch (err) {
  console.log(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
console.log('Token: tenant ' + me.tenant + ', groups [' + me.groups.join(', ') + '], ' + me.tokenUse + ' token, ' +
  (me.minutesLeft > 0 ? me.minutesLeft + ' min left' : 'EXPIRED'));
if (me.minutesLeft <= 0) { console.log('Sign in to the board again and copy a fresh one.'); process.exit(2); }
if (me.tokenUse !== 'access') { console.log('That is an ' + me.tokenUse + ' token - copy the ACCESS token (netpulse.session).'); process.exit(2); }

// --- Where things are -------------------------------------------------------
let webEnv: Record<string, string> = {};
try { webEnv = parseEnvFile(readFileSync('web/.env.cognito.local', 'utf8')); } catch { /* reported per check below */ }

function tfOutputs(dir: string): Record<string, unknown> {
  try {
    const raw = execFileSync('terraform', ['-chdir=' + dir, 'output', '-json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, { value: unknown }>).map(([k, v]) => [k, v.value]));
  } catch {
    return {};
  }
}
const agentcore = tfOutputs('infra/terraform/agentcore');
const boardApi = webEnv.VITE_BOARD_API_URL ?? '';
const agentArn = webEnv.VITE_AGENT_RUNTIME_ARN ?? String(agentcore.agent_runtime_arn ?? '');
const gatewayUrl = typeof agentcore.mcp_gateway_url === 'string' ? agentcore.mcp_gateway_url : '';
const mcpArn = typeof agentcore.mcp_runtime_arn === 'string' ? agentcore.mcp_runtime_arn : '';

const checks: Check[] = [];
const skipped = (name: string, detail: string) => checks.push({ name, status: 'skip', detail });
const bearer = { authorization: 'Bearer ' + token };

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await run(ctl.signal); } finally { clearTimeout(timer); }
}
const describe = (err: unknown) => (err instanceof McpError && err.status ? 'HTTP ' + err.status + ': ' : '') +
  (err instanceof Error ? err.message : String(err));

// --- 1. The board API ---------------------------------------------------------
if (!boardApi) {
  skipped('board API', 'VITE_BOARD_API_URL is not in web/.env.cognito.local - run pnpm web:env');
} else {
  const get = async (path: string) => {
    const res = await fetch(boardApi + path, { headers: bearer });
    return { status: res.status, body: res.ok ? await res.json() as unknown : undefined };
  };
  const board = await get('/board');
  checks.push(judgeBoard(board.status, board.body, me.tenant));
  const comms = await get('/comms');
  checks.push(judgeComms(comms.status, comms.body));
  const audit = await get('/audit');
  checks.push(judgeAudit(audit.status, audit.body));
}

// --- 2. The MCP server through the Gateway, and the lock behind it -----------
if (!gatewayUrl) {
  skipped('MCP via Gateway', 'no mcp_gateway_url output - the Gateway is not applied yet (docs/13, step 2)');
} else {
  const client = createMcpToolProvider({ url: gatewayTargetUrl(gatewayUrl, 'tools'), token });
  try {
    const tools = await client.list();
    checks.push(judgeGatewayList({ tools: tools.map((t) => t.name), sessionId: client.sessionId }));
    try {
      checks.push(judgeGatewayCall({ text: await client.call('explainIncident', {}) }));
    } catch (err) {
      checks.push(judgeGatewayCall({ error: describe(err) }));
    }
  } catch (err) {
    checks.push(judgeGatewayList({ error: describe(err) }));
  }
  if (mcpArn) {
    try {
      await createMcpToolProvider({ url: runtimeInvocationUrl(mcpArn), token }).list();
      checks.push(judgeDirectRefused({ ok: true }));
    } catch (err) {
      checks.push(judgeDirectRefused({ ok: false, error: describe(err) }));
    }
  }
}

// --- 3. The agent, end to end ------------------------------------------------
if (!agentArn) {
  skipped('Agent on AgentCore', 'no agent runtime ARN - VITE_AGENT_RUNTIME_ARN, or the agentcore outputs');
} else {
  try {
    const res = await withTimeout(90_000, (signal) => fetch(runtimeInvocationUrl(agentArn), {
      method: 'POST', signal,
      headers: {
        ...bearer, 'content-type': 'application/json',
        // AgentCore wants >= 33 characters; a fresh one, so this never lands
        // in the board's own conversation.
        'x-amzn-bedrock-agentcore-runtime-session-id': 'smoke-' + crypto.randomUUID(),
      },
      body: JSON.stringify({ question: 'Why is call quality bad in Houston?', newConversation: true }),
    }));
    checks.push(judgeAgent(res.status, res.ok ? await res.json() : undefined));
  } catch (err) {
    checks.push(judgeAgent(0, { error: describe(err) }));
  }
}

// --- The report ----------------------------------------------------------------
const mark = { pass: '\x1b[32mPASS\x1b[0m', fail: '\x1b[31mFAIL\x1b[0m', skip: '\x1b[90mSKIP\x1b[0m' };
console.log('');
for (const c of checks) {
  console.log(mark[c.status] + '  ' + c.name + '\n      ' + c.detail + (c.fix ? '\n      fix: ' + c.fix : ''));
}
const failed = checks.filter((c) => c.status === 'fail').length;
console.log('\n' + (failed ? failed + ' failed.' : 'Nothing failed.') +
  ' ' + checks.filter((c) => c.status === 'skip').length + ' skipped.');
process.exit(failed ? 1 : 0);
