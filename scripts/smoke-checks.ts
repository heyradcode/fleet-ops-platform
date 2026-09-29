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
  both: 'pnpm build:lambda, terraform apply in infra/terraform/auth, then pnpm seed:aws',
};

/**
 * What the token says about who you are - WITHOUT the token. Decoded, not
 * verified: this is for the report, and every endpoint verifies it for real.
 * Nothing returned here may contain the token or its signature.
 */
export function tokenSummary(token: string, nowMs: number): {
  tenant: string; groups: string[]; tokenUse: string; minutesLeft: number; sub: string;
} {
  // STRICT: three base64url segments and nothing else. A pasted token that
  // picked up a line break still decodes (atob skips whitespace) - and then
  // fetch refuses the header with an error that QUOTES THE WHOLE TOKEN,
  // which the report would print. Refused here, before any request.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('that is not a JWT - copy the whole value of sessionStorage "netpulse.session", on one line');
  }
  const c = JSON.parse(b64urlDecodeText(token.split('.')[1])) as Record<string, unknown>;
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

/** A 401 is the token, whichever endpoint says it - never "redeploy". */
const stale = (name: string): Check => fail(name, '401 - the token was refused', 'sign in to the board again and copy a fresh token');

export function judgeBoard(status: number, body: unknown, tenant: string): Check {
  const name = 'board API: GET /board';
  if (status === 401) return stale(name);
  if (status !== 200 || body === undefined) return fail(name, 'HTTP ' + status + (body === undefined ? ', no JSON body' : ''), FIX.boardApi);
  const sites = ((body as { sites?: Array<{ siteId: string }> }).sites ?? []).map((s) => s.siteId);
  if (tenant === 'hhs-demo' && !sites.includes('hou-01')) {
    return fail(name, 'sites ' + sites.join(', ') + ' - the Lambda predates the HHS estate', FIX.boardApi);
  }
  return pass(name, sites.length + ' sites: ' + sites.join(', '));
}

export function judgeComms(status: number, body: unknown): Check {
  const name = 'board API: GET /comms + candidate causes';
  if (status === 401) return stale(name);
  if (status !== 200 || body === undefined) return fail(name, 'HTTP ' + status + (body === undefined ? ', no JSON body' : ''), FIX.boardApi);
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

type SnapshotShape = {
  incidents?: Array<{ incidentId: string; kinds?: string[]; subject: { kind: string; id: string; name?: string } }>;
  causes?: Record<string, { status: string; causes?: Array<{ device: string; path?: string }>; reason?: string; searched?: string }>;
  health?: { sources?: Array<{ source: string; status: string; lastError?: string }> };
};

/**
 * The graph's other two paths, and the source nobody else can see. Each one
 * has its own "not deployed yet" signature, and they differ in WHICH half is
 * old - the Lambda (code that does not know the path) or the table (a graph
 * or a poll from before it) - so each FAIL names the right fix.
 *
 * Returns nothing when there is no comms view: judgeComms already said why.
 */
export function judgeGraphPaths(status: number, body: unknown): Check[] {
  if (status !== 200 || !body) return [];
  const snap = body as SnapshotShape;
  if (!snap.causes) return [];
  const causeOf = (kind: string) => {
    const i = snap.incidents?.find((x) => x.subject.kind === kind);
    return i ? { incident: i, cause: snap.causes![i.incidentId] } : undefined;
  };
  const checks: Check[] = [];

  const trunk = causeOf('trunk');
  const t = 'graph: a failing trunk follows its SBC\'s path';
  if (!trunk) checks.push(skip(t, 'no trunk incident open to check'));
  else if (trunk.cause?.status === 'found' && trunk.cause.causes?.[0]?.path?.includes('RUNS_ON')) {
    checks.push(pass(t, trunk.incident.subject.id.split('.')[0] + ': top candidate ' + trunk.cause.causes[0].device));
  } else if (trunk.cause?.status === 'none') {
    // The path was found and searched; nothing was raised on it. An answer.
    checks.push(pass(t, 'looked: ' + (trunk.cause.searched ?? 'the SBC\'s path')));
  } else if (trunk.cause?.status === 'unknown') checks.push(fail(t, '"' + (trunk.cause.reason ?? 'unknown') + '"', FIX.seed));
  // The Lambda before the SBC link gave this very reason for EVERY trunk;
  // the new one gives it only when the stored graph has no RUNS_ON edge.
  else checks.push(fail(t, (trunk.cause?.status ?? 'no answer') + ': "' + (trunk.cause?.reason ?? '') +
    '" - the Lambda or the stored graph predates the SBC link', FIX.both));

  const queue = causeOf('queue');
  const q = 'graph: an overwhelmed queue follows its staffing';
  const qr = queue?.cause?.reason ?? '';
  if (!queue) checks.push(skip(q, 'no queue incident open to check'));
  else if (queue.cause?.status === 'found' && queue.cause.causes?.[0]?.path?.includes('STAFFED_FROM')) {
    checks.push(pass(q, '"' + (queue.incident.subject.name ?? queue.incident.subject.id) + '": top candidate ' + queue.cause.causes[0].device));
  } else if (/not a place on the network/.test(qr)) checks.push(fail(q, 'the Lambda predates queue staffing', FIX.boardApi));
  else if (/no staffing is recorded/.test(qr)) checks.push(fail(q, 'no staffing in the table - no poll has stored it', FIX.seed));
  // Too thin to be a candidate is an ANSWER, not a deploy problem.
  else if (/no building staffs a fifth/.test(qr)) checks.push(pass(q, 'looked: ' + qr));
  else if (queue.cause?.status === 'none') checks.push(pass(q, 'looked: ' + (queue.cause.searched ?? 'its staffing buildings')));
  else if (queue.cause?.status === 'unknown') checks.push(fail(q, '"' + qr + '"', FIX.seed));
  else checks.push(fail(q, String(queue.cause?.status) + ': "' + qr + '"', FIX.both));

  const d = 'comms: desk-phone registration (CUCM)';
  const phones = snap.incidents?.find((i) => i.kinds?.includes('desk-phone-registration'));
  const cucm = snap.health?.sources?.find((s) => s.source === 'cucm');
  if (phones) checks.push(pass(d, 'desk phones dropping at LC=' + phones.subject.id + ', from the call control alone'));
  // Down is not "no phones dropping": nobody could ask.
  else if (cucm?.status === 'down') checks.push(fail(d, 'CUCM was down at the last poll: ' + (cucm.lastError ?? 'no reason recorded'), FIX.seed));
  else if (cucm && cucm.status !== 'not-configured') checks.push(pass(d, 'CUCM ' + cucm.status + '; no building\'s phones dropping'));
  else checks.push(fail(d, 'no CUCM row in the stored health - the last poll predates it', FIX.seed));
  return checks;
}

/**
 * Checked LAST, after this run's own MCP calls - because a broken audit write
 * is SILENT by design (logged, never failing the call), a trail that merely
 * answers proves nothing. When this run called a tool through the Gateway,
 * at least one row for THIS caller since the run started must be there.
 */
export function judgeAudit(status: number, body: unknown, expect?: { sub: string; since: string }): Check {
  const name = 'board API: GET /audit';
  if (status === 401) return stale(name);
  if (status === 404) return fail(name, '404 - the route is not deployed', FIX.boardApi);
  if (status !== 200 || body === undefined) return fail(name, 'HTTP ' + status, FIX.boardApi);
  if (body === null) return skip(name, 'not an admin - the audit view is admins only');
  const entries = (body as { entries?: Array<{ via: string; sub: string; at: string }> }).entries ?? [];
  const mcp = entries.filter((e) => e.via === 'mcp').length;
  const summary = entries.length + ' recent calls, ' + mcp + ' recorded by the MCP server';
  if (!expect) return pass(name, summary);
  const mine = entries.filter((e) => e.via === 'mcp' && e.sub === expect.sub && e.at >= expect.since).length;
  if (mine === 0) {
    return fail(name, summary + ' - but NONE for the calls this run just made. Audit writes fail silently by design; ' +
      'look in the MCP runtime log for "audit: tool call NOT recorded"',
      'the MCP role PutItem permission (dynamodb:LeadingKeys TENANT#*#AUDIT) - terraform apply in infra/terraform/agentcore');
  }
  return pass(name, summary + '; ' + mine + ' from this run, as you');
}

// ---------------------------------------------------------------------------
// MCP through the gateway
// ---------------------------------------------------------------------------

export function judgeGatewayList(result: { tools?: string[]; error?: string; sessionId?: string }, expectGraph = false): Check {
  const name = 'MCP via Gateway: tools/list';
  if (result.error) {
    // 406 is OUR server refusing a request without the MCP Accept header -
    // the one header question the Gateway docs leave open. The fix is to
    // let it through; Mcp-Session-Id must NOT be listed (AgentCore manages it,
    // and listing it is a 400).
    if (/^HTTP 406/.test(result.error)) {
      return fail(name, result.error + ' - the Gateway did not forward the Accept header',
        'add metadata_configuration { allowed_request_headers = ["Accept", "MCP-Protocol-Version"] } to the gateway target (gateway.tf), then apply agentcore');
    }
    const fix = /^HTTP 40[13]/.test(result.error) ? FIX.agentcore + ' - and check the token is an ACCESS token from the same pool' : FIX.agentcore;
    return fail(name, result.error, fix);
  }
  const tools = result.tools ?? [];
  const graph = ['whatServes', 'explainIncident', 'graphNeighbours'].filter((t) => tools.includes(t));
  if (tools.length === 0) return fail(name, 'the server listed no tools at all', FIX.agentcore);
  if (expectGraph && graph.length < 3) {
    return fail(name, graph.length + '/3 graph tools for a tenant-wide HHS caller - the MCP bundle predates them', FIX.agentcore);
  }
  return pass(name, tools.length + ' tools (' + graph.length + '/3 graph tools); Mcp-Session-Id ' +
    (result.sessionId ? 'came back through the gateway' : 'did NOT come back - calls will not stick to a warm microVM (correct, but slower)'));
}

export function judgeGatewayCall(result: { tool: string; text?: string; error?: string }): Check {
  const name = 'MCP via Gateway: tools/call ' + result.tool;
  if (result.error) return fail(name, result.error, FIX.agentcore);
  const text = result.text ?? '';
  if (text.startsWith('ERROR')) return fail(name, text.split('\n')[0], FIX.agentcore);
  const firstCandidate = text.split('\n').find((l) => l.includes('CANDIDATE'));
  return pass(name, firstCandidate ? firstCandidate.trim() : text.split('\n')[0]);
}


// ---------------------------------------------------------------------------
// The agent, end to end
// ---------------------------------------------------------------------------

export function judgeAgent(status: number, body: unknown, error?: string): Check {
  const name = 'Agent on AgentCore: tools over MCP via Gateway';
  if (error) return fail(name, 'no answer: ' + error, FIX.agentcore);
  if (status === 401) return stale(name);
  if (status !== 200) return fail(name, 'HTTP ' + status + (status === 403 ? ' - check the deploy and the token' : ''), FIX.agentcore);
  const r = body as { stoppedBecause?: string; servedBy?: { tools?: string; toolsRoute?: string; model?: string } };
  const s = r.servedBy;
  if (s?.tools !== 'mcp') return fail(name, 'tools ran ' + String(s?.tools ?? 'in an unknown place') + ' - the agent is not using the MCP server', FIX.agentcore);
  if (s.toolsRoute !== 'gateway') return fail(name, 'tools over MCP, but ' + String(s.toolsRoute ?? 'direct') + ' - the agent is not pointed at the gateway', FIX.agentcore);
  if (r.stoppedBecause !== 'end_turn') return fail(name, 'stopped: ' + String(r.stoppedBecause), FIX.agentcore);
  return pass(name, 'answered (' + String(s.model) + '), tools over MCP via Gateway');
}
