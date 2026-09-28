/**
 * After a deploy: check the deployed path end to end, AS YOU.
 *
 *   NETPULSE_TOKEN=<your access token> pnpm smoke:aws
 *
 * Every piece that has to be applied in order - the board API, the knowledge
 * graph in DynamoDB, the Gateway, the MCP server behind it, the agent pointed
 * at it, the audit trail - checked with the same token the board sends, and
 * each FAIL naming
 * the command that fixes it. It replaces "ask the assistant something and
 * tell me what it said" with a list.
 *
 * YOUR TOKEN IS A CREDENTIAL, and three rules keep it one:
 *   - it must be a well-formed JWT before anything is sent (smoke-checks.ts:
 *     a malformed header makes fetch throw an error QUOTING the token);
 *   - it goes only to https AWS hosts - the board API's execute-api host,
 *     and the AgentCore hosts the URL helpers refuse to build otherwise;
 *   - every error text is passed through `redact` before it is printed.
 * The report shows who the token says you are, decoded locally, and how many
 * minutes it has left. It lives an hour.
 *
 * Endpoints come from what the deploy already wrote: web/.env.cognito.local
 * (`pnpm web:env`) for the board API and the agent, and the agentcore root's
 * Terraform outputs for the Gateway and the MCP runtime. Nothing here writes
 * anything except what any tool call writes: the MCP server audits this
 * run's calls like every other - which is the last thing checked.
 *
 * Node only (process, child_process, fs): it lives in scripts/.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createMcpToolProvider, McpError } from '../src/ai/mcp/client.ts';
import { gatewayTargetUrl, runtimeInvocationUrl } from '../src/aws/agentcore-url.ts';
import {
  judgeAgent, judgeAudit, judgeBoard, judgeComms, judgeGatewayCall, judgeGatewayList,
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

/** Every message that reaches the report goes through here. */
const redact = (text: string) => text.split(token).join('<token>');
const describe = (err: unknown) => redact(
  (err instanceof McpError && err.status ? 'HTTP ' + err.status + ': ' : '') + (err instanceof Error ? err.message : String(err)),
);

let me: ReturnType<typeof tokenSummary>;
try {
  me = tokenSummary(token, Date.now());
} catch (err) {
  console.log(describe(err));
  process.exit(2);
}
console.log('Token: tenant ' + me.tenant + ', groups [' + me.groups.join(', ') + '], ' + me.tokenUse + ' token, ' +
  (me.minutesLeft > 0 ? me.minutesLeft + ' min left' : 'EXPIRED'));
// Five minutes, not zero: the checks take a minute, and a token that dies
// half-way turns every later check into a misleading 401.
if (me.minutesLeft < 5) { console.log('Sign in to the board again and copy a fresh one.'); process.exit(2); }
if (me.tokenUse !== 'access') { console.log('That is an ' + me.tokenUse + ' token - copy the ACCESS token (netpulse.session).'); process.exit(2); }

/**
 * What this run's own audit rows are recognised by. Two minutes early: the
 * rows are stamped by AWS's clock and this is yours, and a laptop running a
 * minute fast would otherwise hide a row that did arrive.
 */
const startedAt = new Date(Date.now() - 120_000).toISOString();

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

/** The board API is sent the token too - so only an https AWS host is. */
function awsHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /\.amazonaws\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Every request gives up after 30s: a hanging endpoint is a finding, not a hung script. */
const timed = (ms = 30_000): typeof fetch => (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(ms) });

const checks: Check[] = [];
const skipped = (name: string, detail: string) => checks.push({ name, status: 'skip', detail });
const bearer = { authorization: 'Bearer ' + token };

// --- 1. The board API ---------------------------------------------------------
async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await timed()(boardApi + path, { headers: bearer });
  let body: unknown;
  // A 200 whose body is not JSON (a proxy's HTML page) is reported, not a crash.
  try { body = res.ok ? await res.json() as unknown : undefined; } catch { body = undefined; }
  return { status: res.status, body };
}

if (!boardApi) {
  skipped('board API', 'VITE_BOARD_API_URL is not in web/.env.cognito.local - run pnpm web:env');
} else if (!awsHttps(boardApi)) {
  checks.push({ name: 'board API', status: 'fail', detail: 'refusing to send your token to ' + redact(boardApi) + ' - not an https AWS host', fix: 'check VITE_BOARD_API_URL (pnpm web:env)' });
} else {
  try {
    const board = await get('/board');
    checks.push(judgeBoard(board.status, board.body, me.tenant));
    const comms = await get('/comms');
    checks.push(judgeComms(comms.status, comms.body));
  } catch (err) {
    checks.push({ name: 'board API', status: 'fail', detail: 'no answer: ' + describe(err), fix: 'check the network, and VITE_BOARD_API_URL' });
  }
}

// --- 2. The MCP server through the Gateway ----------------------------------
let calledThroughGateway = false;
if (!gatewayUrl) {
  skipped('MCP via Gateway', 'no mcp_gateway_url output - the Gateway is not applied yet (docs/13, step 5)');
} else {
  try {
    const client = createMcpToolProvider({ url: gatewayTargetUrl(gatewayUrl, 'tools'), token, fetch: timed() });
    const names = (await client.list()).map((t) => t.name);
    const tenantWide = me.groups.includes('admin') || me.groups.includes('engineer');
    checks.push(judgeGatewayList({ tools: names, sessionId: client.sessionId }, me.tenant === 'hhs-demo' && tenantWide));
    // Only a tool the server LISTED for this caller. Calling one it did not
    // is refused by design - and audited as a refusal under your name.
    const tool = ['explainIncident', 'listOpenIncidents'].find((t) => names.includes(t));
    if (!tool) {
      skipped('MCP via Gateway: tools/call', 'none of explainIncident / listOpenIncidents was listed for you');
    } else {
      try {
        checks.push(judgeGatewayCall({ tool, text: await client.call(tool, {}) }));
        calledThroughGateway = true;
      } catch (err) {
        checks.push(judgeGatewayCall({ tool, error: describe(err) }));
      }
    }
  } catch (err) {
    checks.push(judgeGatewayList({ error: describe(err) }));
  }
  // No "direct call refused" check: the runtime cannot be locked to the
  // gateway while the gateway passes the user's token through (mcp.tf).
}

// --- 3. The agent, end to end ------------------------------------------------
if (!agentArn) {
  skipped('Agent on AgentCore', 'no agent runtime ARN - VITE_AGENT_RUNTIME_ARN, or the agentcore outputs');
} else {
  try {
    const res = await timed(90_000)(runtimeInvocationUrl(agentArn), {
      method: 'POST',
      headers: {
        ...bearer, 'content-type': 'application/json',
        // AgentCore wants >= 33 characters; a fresh one, so this never lands
        // in the board's own conversation.
        'x-amzn-bedrock-agentcore-runtime-session-id': 'smoke-' + crypto.randomUUID(),
      },
      body: JSON.stringify({ question: 'Why is call quality bad in Houston?', newConversation: true }),
    });
    let body: unknown;
    try { body = res.ok ? await res.json() : undefined; } catch { body = undefined; }
    checks.push(judgeAgent(res.status, body));
  } catch (err) {
    checks.push(judgeAgent(0, undefined, describe(err)));
  }
}

// --- 4. The audit trail, LAST: this run's own calls must be in it ------------
if (boardApi && awsHttps(boardApi)) {
  try {
    const audit = await get('/audit');
    checks.push(judgeAudit(audit.status, audit.body, calledThroughGateway ? { sub: me.sub, since: startedAt } : undefined));
  } catch (err) {
    checks.push({ name: 'board API: GET /audit', status: 'fail', detail: 'no answer: ' + describe(err), fix: 'check the network' });
  }
}

// --- The report ----------------------------------------------------------------
const mark = { pass: '\x1b[32mPASS\x1b[0m', fail: '\x1b[31mFAIL\x1b[0m', skip: '\x1b[90mSKIP\x1b[0m' };
console.log('');
for (const c of checks) {
  console.log(mark[c.status] + '  ' + c.name + '\n      ' + redact(c.detail) + (c.fix ? '\n      fix: ' + c.fix : ''));
}
const failed = checks.filter((c) => c.status === 'fail').length;
console.log('\n' + (failed ? failed + ' failed.' : 'Nothing failed.') +
  ' ' + checks.filter((c) => c.status === 'skip').length + ' skipped.');
process.exit(failed ? 1 : 0);
