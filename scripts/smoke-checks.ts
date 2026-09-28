/**
 * What `pnpm smoke:aws` concludes from each response - pure, so it is tested
 * against real snapshot shapes (smoke-checks.test.ts) rather than trusted.
 * The script itself (smoke-aws.ts) only does the I/O.
 *
 * Every FAIL names its FIX: the command that deploys the missing piece. A
 * smoke test that says "comms: failed" leaves the person where they started;
 * one that says "run pnpm seed:aws - the graph is not in DynamoDB" does not.
 */
import { b64urlDecodeText } from '../src/platform/crypto.ts';

export type CheckStatus = 'pass' | 'fail' | 'skip';
export type Check = { name: string; status: CheckStatus; detail: string; fix?: string };

const pass = (name: string, detail: string): Check => ({ name, status: 'pass', detail });
const fail = (name: string, detail: string, fix: string): Check => ({ name, status: 'fail', detail, fix });
const skip = (name: string, detail: string): Check => ({ name, status: 'skip', detail });

const FIX = {
  boardApi: 'pnpm build:lambda, then terraform apply in infra/terraform/auth',
  seed: 'TABLE_NAME=$(terraform -chdir=infra/terraform/auth output -raw main_table_name) pnpm seed:aws',
  agentcore: 'pnpm build:agent, then terraform apply in infra/terraform/agentcore',
};

/**
 * What the token says about who you are - WITHOUT the token. Decoded, not
 * verified: this is for the report, and every endpoint verifies it for real.
 * Nothing returned here may contain the token or its signature.
 */
export function tokenSummary(token: string, nowMs: number): {
  tenant: string; groups: string[]; tokenUse: string; minutesLeft: number; sub: string;
} {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('that is not a JWT - copy the whole value of sessionStorage "netpulse.session"');
  const c = JSON.parse(b64urlDecodeText(parts[1])) as Record<string, unknown>;
  return {
    tenant: String(c['custom:tenantId'] ?? '(none)'),
    groups: Array.isArray(c['cognito:groups']) ? c['cognito:groups'].map(String) : [],
    tokenUse: String(c.token_use ?? '(none)'),
    minutesLeft: Math.floor((Number(c.exp ?? 0) * 1000 - nowMs) / 60_000),
    sub: String(c.sub ?? ''),
  };
}

/** KEY=VALUE lines, as `pnpm web:env` writes them. Comments and blanks ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// ---------------------------------------------------------------------------
// The board API
// ---------------------------------------------------------------------------

export function judgeBoard(status: number, body: unknown, tenant: string): Check {
  const name = 'board API: GET /board';
  if (status === 401) return fail(name, '401 - the token was refused', 'sign in to the board again and copy a fresh token');
  if (status !== 200) return fail(name, 'HTTP ' + status, FIX.boardApi);
  const sites = ((body as { sites?: Array<{ siteId: string }> }).sites ?? []).map((s) => s.siteId);
  if (tenant === 'hhs-demo' && !sites.includes('hou-01')) {
    return fail(name, 'sites ' + sites.join(', ') + ' - the Lambda predates the HHS estate', FIX.boardApi);
  }
  return pass(name, sites.length + ' sites: ' + sites.join(', '));
}

export function judgeComms(status: number, body: unknown): Check {
  const name = 'board API: GET /comms + candidate causes';
  if (status !== 200) return fail(name, 'HTTP ' + status, FIX.boardApi);
  if (body === null) return skip(name, 'no comms view for this account (not tenant-wide, or no comms sources)');
  const snap = body as { incidents?: Array<{ incidentId: string; subject: { kind: string; id: string } }>; causes?: Record<string, { status: string; causes?: Array<{ device: string }>; reason?: string }> };
  if (!snap.causes) return fail(name, 'no "causes" in the response - the Lambda predates the knowledge graph', FIX.boardApi);
  const houston = snap.incidents?.find((i) => i.subject.kind === 'facility' && i.subject.id === '1120');
  if (!houston) return pass(name, (snap.incidents?.length ?? 0) + ' open incidents; no Houston incident to check candidates against');
  const c = snap.causes[houston.incidentId];
  if (c?.status === 'found') return pass(name, 'Houston: top candidate ' + (c.causes?.[0]?.device ?? '?'));
  if (c?.status === 'unknown') return fail(name, 'Houston: "' + (c.reason ?? 'unknown') + '"', FIX.seed);
  return fail(name, 'Houston: status ' + String(c?.status) + ' - expected the WAN edge as a candidate', FIX.boardApi);
}

export function judgeAudit(status: number, body: unknown): Check {
  const name = 'board API: GET /audit';
  if (status === 404) return fail(name, '404 - the route is not deployed', FIX.boardApi);
  if (status !== 200) return fail(name, 'HTTP ' + status, FIX.boardApi);
  if (body === null) return skip(name, 'not an admin - the audit view is admins only');
  const entries = (body as { entries?: Array<{ via: string }> }).entries ?? [];
  const mcp = entries.filter((e) => e.via === 'mcp').length;
  return pass(name, entries.length + ' recent calls, ' + mcp + ' recorded by the MCP server');
}

// ---------------------------------------------------------------------------
// MCP through the gateway, and the lock behind it
// ---------------------------------------------------------------------------

export function judgeGatewayList(result: { tools?: string[]; error?: string; sessionId?: string }): Check {
  const name = 'MCP via Gateway: tools/list';
  if (result.error) {
    const fix = /40[13]/.test(result.error) ? FIX.agentcore + ' - and check the token is an ACCESS token from the same pool' : FIX.agentcore;
    return fail(name, result.error, fix);
  }
  const tools = result.tools ?? [];
  const graph = ['whatServes', 'explainIncident', 'graphNeighbours'].filter((t) => tools.includes(t));
  return pass(name, tools.length + ' tools (' + graph.length + '/3 graph tools); Mcp-Session-Id ' +
    (result.sessionId ? 'came back through the gateway' : 'did NOT come back - calls will not stick to a warm microVM (correct, but slower)'));
}

export function judgeGatewayCall(result: { text?: string; error?: string }): Check {
  const name = 'MCP via Gateway: tools/call explainIncident';
  if (result.error) return fail(name, result.error, FIX.agentcore);
  const text = result.text ?? '';
  if (text.startsWith('ERROR')) return fail(name, text.split('\n')[0], FIX.agentcore);
  const firstCandidate = text.split('\n').find((l) => l.includes('CANDIDATE'));
  return pass(name, firstCandidate ? firstCandidate.trim() : text.split('\n')[0]);
}

/** The direct address MUST refuse once the gateway fronts the runtime. Success here is the failure. */
export function judgeDirectRefused(result: { ok: boolean; error?: string }): Check {
  const name = 'MCP runtime refuses calls that skip the Gateway';
  if (result.ok) return fail(name, 'the runtime answered a direct call - the gateway-only lock is not applied', FIX.agentcore);
  if (result.error && /40[13]/.test(result.error)) return pass(name, 'refused (' + (/40[13]/.exec(result.error)?.[0] ?? '') + ')');
  return fail(name, 'unexpected: ' + String(result.error), FIX.agentcore);
}

// ---------------------------------------------------------------------------
// The agent, end to end
// ---------------------------------------------------------------------------

export function judgeAgent(status: number, body: unknown): Check {
  const name = 'Agent on AgentCore: tools over MCP via Gateway';
  if (status !== 200) return fail(name, 'HTTP ' + status + (status === 403 ? ' - check the deploy and the token' : ''), FIX.agentcore);
  const r = body as { stoppedBecause?: string; servedBy?: { tools?: string; toolsRoute?: string; model?: string } };
  const s = r.servedBy;
  if (s?.tools !== 'mcp') return fail(name, 'tools ran ' + String(s?.tools ?? 'in an unknown place') + ' - the agent is not using the MCP server', FIX.agentcore);
  if (s.toolsRoute !== 'gateway') return fail(name, 'tools over MCP, but ' + String(s.toolsRoute ?? 'direct') + ' - the agent is not pointed at the gateway', FIX.agentcore);
  if (r.stoppedBecause !== 'end_turn') return fail(name, 'stopped: ' + String(r.stoppedBecause), FIX.agentcore);
  return pass(name, 'answered (' + String(s.model) + '), tools over MCP via Gateway');
}
