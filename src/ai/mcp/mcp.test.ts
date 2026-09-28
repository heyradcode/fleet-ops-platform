/**
 * The MCP server, its HTTP transport, the client, and the agent through all
 * three - with a fake fetch that hands each request straight to `serveMcp`,
 * so the bytes the client sends are the bytes the server parses.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import type { Principal } from '../../platform/types.ts';
import { setRunbooks } from '../../platform/runbook-loader.ts';
import { loadRunbooksFromDisk } from '../../platform/runbook-loader.node.ts';
import { toolSpecsFor } from '../tools.ts';
import { runTool, prepareToolWorld } from '../tool-provider.ts';
import { recentAudit, recordToolCall, hashArgs } from '../audit.ts';
import { keys, mainTable } from '../../aws/dynamodb.ts';
import { handleAgentInvocation } from '../agent-invocation.ts';
import type { AgentResult } from '../agent-core.ts';
import { handleMcpMessage, RPC, type JsonRpcRequest } from './server.ts';
import { serveMcp, type McpHttpDeps } from './http.ts';
import { createMcpToolProvider, SESSION_BUSY } from './client.ts';

const OPERATOR: Principal = {
  sub: 'mcp-op', email: 'op@acme-networks.com', tenantId: 'acme-networks',
  roles: ['operator'], scope: { kind: 'site', siteId: 'dal-01' }, identityProvider: 'cognito',
};
const ADMIN: Principal = { ...OPERATOR, sub: 'mcp-admin', roles: ['admin'], scope: { kind: 'tenant' } };
const OTHER_ADMIN: Principal = { ...ADMIN, sub: 'mcp-other', tenantId: 'globex' };

const TOKENS: Record<string, Principal> = { 'tok-op': OPERATOR, 'tok-admin': ADMIN, 'tok-other': OTHER_ADMIN };
const verify = async (token: string) => {
  const p = TOKENS[token];
  if (!p) throw new Error('bad token');
  return p;
};
const noAudit = async () => {};

before(() => setRunbooks(loadRunbooksFromDisk()));

const rpc = (id: number | undefined, method: string, params?: Record<string, unknown>): JsonRpcRequest =>
  ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) });

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

test('initialize agrees a version it speaks, and offers tools only', async () => {
  const same = await handleMcpMessage(rpc(1, 'initialize', { protocolVersion: '2025-03-26' }), OPERATOR);
  const newer = await handleMcpMessage(rpc(2, 'initialize', { protocolVersion: '2099-01-01' }), OPERATOR);
  assert.ok(same && 'result' in same && newer && 'result' in newer);
  const r1 = same.result as { protocolVersion: string; capabilities: Record<string, unknown> };
  assert.equal(r1.protocolVersion, '2025-03-26');
  assert.deepEqual(Object.keys(r1.capabilities), ['tools']);
  assert.equal((newer.result as { protocolVersion: string }).protocolVersion, '2025-06-18', 'an unknown version gets our latest');
});

test('a notification gets no response; an unknown method is -32601', async () => {
  assert.equal(await handleMcpMessage(rpc(undefined, 'notifications/initialized'), OPERATOR), undefined);
  const out = await handleMcpMessage(rpc(3, 'resources/list'), OPERATOR);
  assert.ok(out && 'error' in out);
  assert.equal(out.error.code, RPC.methodNotFound);
});

test('tools/list is the READ set for this caller - an admin is not listed a tool that pages anyone', async () => {
  const out = await handleMcpMessage(rpc(4, 'tools/list'), ADMIN);
  assert.ok(out && 'result' in out);
  const names = (out.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools.map((t) => t.name);
  assert.deepEqual(names, toolSpecsFor(ADMIN, { readOnly: true }).map((t) => t.name));
  assert.ok(!names.includes('openIncident') && !names.includes('suppressAlarm'));
});

test('calling a tool that was not listed is -32602 - and is audited as refused', async () => {
  const seen: string[] = [];
  const audit = async (_p: Principal, c: { tool: string; outcome: string }) => { seen.push(c.tool + ':' + c.outcome); };
  const out = await handleMcpMessage(rpc(5, 'tools/call', { name: 'openIncident', arguments: { title: 'x' } }), ADMIN, { audit });
  assert.ok(out && 'error' in out);
  assert.equal(out.error.code, RPC.invalidParams);
  assert.deepEqual(seen, ['openIncident:refused']);
});

test('tools/call returns exactly what the in-process tool returns', async () => {
  const args = { query: 'link down on an access switch' };
  const out = await handleMcpMessage(rpc(6, 'tools/call', { name: 'searchRunbooks', arguments: args }), OPERATOR, { audit: noAudit });
  assert.ok(out && 'result' in out);
  const result = out.result as { content: Array<{ type: string; text: string }>; isError: boolean };
  await prepareToolWorld(OPERATOR);
  assert.equal(result.content[0].text, await runTool('searchRunbooks', args, OPERATOR));
  assert.equal(result.isError, false);
});

test('a tool that fails is a RESULT with isError, not a protocol error', async () => {
  const out = await handleMcpMessage(rpc(7, 'tools/call', { name: 'traceTopology', arguments: { deviceId: 'no-such-device' } }), OPERATOR, { audit: noAudit });
  assert.ok(out && 'result' in out, 'not a JSON-RPC error');
  const result = out.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(result.isError, result.content[0].text.startsWith('ERROR:'));
});

// ---------------------------------------------------------------------------
// The HTTP transport
// ---------------------------------------------------------------------------

type Captured = { status: number; headers: Record<string, string>; body: string };

async function http(method: string, headers: Record<string, string | undefined>, body: string, deps: McpHttpDeps = { verify, audit: noAudit }): Promise<Captured> {
  const out: Captured = { status: 0, headers: {}, body: '' };
  await serveMcp({ method, headers, body }, deps, {
    writeHead(status, h) { out.status = status; out.headers = h; },
    write(chunk) { out.body += chunk; },
    end() {},
  });
  return out;
}
const GOOD = { authorization: 'Bearer tok-op', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };

test('no token: 401 - and the body is not even parsed', async () => {
  const res = await http('POST', { ...GOOD, authorization: undefined }, 'this is not json');
  assert.equal(res.status, 401);
  assert.equal(res.headers['WWW-Authenticate'], 'Bearer');
  const bad = await http('POST', { ...GOOD, authorization: 'Bearer forged' }, 'this is not json');
  assert.equal(bad.status, 401);
});

test('the spec\'s refusals: GET 405, wrong Accept 406, unknown version 400, junk 400, a batch 400', async () => {
  const ok = JSON.stringify(rpc(1, 'ping'));
  assert.equal((await http('GET', GOOD, '')).status, 405);
  assert.equal((await http('DELETE', GOOD, '')).status, 405);
  assert.equal((await http('POST', { ...GOOD, accept: 'application/json' }, ok)).status, 406);
  assert.equal((await http('POST', { ...GOOD, 'mcp-protocol-version': '1999-01-01' }, ok)).status, 400);
  const junk = await http('POST', GOOD, '{nope');
  assert.equal(junk.status, 400);
  assert.equal(JSON.parse(junk.body).error.code, RPC.parseError);
  assert.equal((await http('POST', GOOD, '[' + ok + ']')).status, 400);
});

test('a notification is 202 with no body; a request is 200 JSON; no version header means 2025-03-26', async () => {
  const note = await http('POST', GOOD, JSON.stringify(rpc(undefined, 'notifications/initialized')));
  assert.equal(note.status, 202);
  assert.equal(note.body, '');
  const ping = await http('POST', { ...GOOD, 'mcp-protocol-version': undefined }, JSON.stringify(rpc(9, 'ping')));
  assert.equal(ping.status, 200);
  assert.deepEqual(JSON.parse(ping.body), { jsonrpc: '2.0', id: 9, result: {} });
});

// ---------------------------------------------------------------------------
// The client, against the real server through a fake fetch
// ---------------------------------------------------------------------------

type Sent = { headers: Record<string, string>; body: Record<string, unknown> };

/** A fetch that serves the MCP server in-process, and assigns a session id like AgentCore. */
function serverFetch(sent: Sent[] = [], deps: McpHttpDeps = { verify, audit: noAudit }, tamper?: (body: Record<string, unknown>) => Response | undefined): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ headers, body });
    const forced = tamper?.(body);
    if (forced) return forced;
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    const res = await http('POST', lower, String(init?.body), deps);
    return new Response(res.status === 202 ? null : res.body, {
      status: res.status,
      headers: { ...res.headers, 'Mcp-Session-Id': 'agentcore-assigned-session-0123456789abcdef' },
    });
  }) as typeof fetch;
}

test('the handshake runs once, first; the session id and version are sent back on every call after', async () => {
  const sent: Sent[] = [];
  const client = createMcpToolProvider({ url: 'https://mcp.test/mcp', token: 'tok-op', fetch: serverFetch(sent) });
  await client.list();
  await client.call('listOpenIncidents', {});
  assert.deepEqual(sent.map((s) => s.body.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(sent[0].headers['MCP-Protocol-Version'], undefined, 'initialize negotiates the version');
  for (const s of sent.slice(1)) {
    assert.equal(s.headers['MCP-Protocol-Version'], '2025-06-18');
    assert.equal(s.headers['Mcp-Session-Id'], 'agentcore-assigned-session-0123456789abcdef');
    assert.equal(s.headers.Authorization, 'Bearer tok-op', 'the CALLER\'s token, every time');
  }
  assert.equal(client.serverInfo?.name, 'netpulse-tools');
});

test('the client lists what the server lists, and a call answers what the tool answers', async () => {
  const client = createMcpToolProvider({ url: 'https://mcp.test/mcp', token: 'tok-op', fetch: serverFetch() });
  assert.deepEqual(await client.list(), toolSpecsFor(OPERATOR, { readOnly: true }));
  await prepareToolWorld(OPERATOR);
  assert.equal(await client.call('listOpenIncidents', {}), await runTool('listOpenIncidents', {}, OPERATOR));
  assert.match(await client.call('openIncident', {}), /^ERROR: Unknown tool/);
});

test('-32005 (AgentCore: session busy) arrives as a 200 and is retried; other errors are not', async () => {
  let busy = 2;
  const waits: number[] = [];
  const fetchImpl = serverFetch([], undefined, (body) => (body.method === 'tools/call' && busy-- > 0
    ? new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: SESSION_BUSY, message: 'Session operation in progress' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : undefined));
  const client = createMcpToolProvider({ url: 'https://mcp.test/mcp', token: 'tok-op', fetch: fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  assert.doesNotMatch(await client.call('listOpenIncidents', {}), /^ERROR/);
  assert.deepEqual(waits, [250, 500]);
});

test('a response sent as an SSE stream is read too - AgentCore\'s own examples stream', async () => {
  const fetchImpl = serverFetch([], undefined, (body) => (body.method === 'tools/call'
    ? new Response(
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
      'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'streamed' }], isError: false } }) + '\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    : undefined));
  const client = createMcpToolProvider({ url: 'https://mcp.test/mcp', token: 'tok-op', fetch: fetchImpl });
  assert.equal(await client.call('listOpenIncidents', {}), 'streamed');
});

test('a rejected token is a transport failure the client throws - it does not pretend to have tools', async () => {
  const client = createMcpToolProvider({ url: 'https://mcp.test/mcp', token: 'forged', fetch: serverFetch() });
  await assert.rejects(client.list(), /answered 401/);
});

// ---------------------------------------------------------------------------
// The agent, with every tool call crossing MCP
// ---------------------------------------------------------------------------

test('the deployed agent through MCP: same answer, tools over MCP, and the calls audited AS the caller', async () => {
  const audited: Array<{ sub: string; tool: string }> = [];
  const deps: McpHttpDeps = { verify, audit: async (p, c) => { audited.push({ sub: p.sub, tool: c.tool }); } };
  const question = 'Why is the Dallas core switch unreachable? What should I do?';

  const viaMcp = await handleAgentInvocation(
    { authorization: 'Bearer tok-op', body: JSON.stringify({ question, newConversation: true }) },
    { verify, tools: (_p, token) => createMcpToolProvider({ url: 'https://mcp.test/mcp', token, fetch: serverFetch([], deps) }) },
  );
  const inProcess = await handleAgentInvocation(
    { authorization: 'Bearer tok-op', body: JSON.stringify({ question, newConversation: true }) },
    { verify },
  );
  const a = viaMcp.body as AgentResult;
  const b = inProcess.body as AgentResult;
  assert.equal(a.servedBy?.tools, 'mcp');
  assert.equal(b.servedBy?.tools, 'in-process');
  assert.equal(a.answer, b.answer, 'where the tools run changes nothing about what they say');
  const calls = a.trace.filter((s) => s.kind === 'tool');
  assert.ok(calls.length > 0);
  assert.equal(audited.length, calls.length, 'every call audited, once');
  assert.ok(audited.every((e) => e.sub === OPERATOR.sub), 'as the person who asked - never as the agent');
});

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

test('the audit trail: per tenant, admins only, arguments hashed and never stored, and it expires', async () => {
  const secret = { query: 'call Jane Doe on 555-0100' };
  await recordToolCall(ADMIN, { tool: 'searchRunbooks', input: secret, outcome: 'ok', ms: 12 });
  const mine = await recentAudit(ADMIN, 10);
  assert.ok(mine.some((e) => e.sub === ADMIN.sub && e.tool === 'searchRunbooks' && e.argsHash === hashArgs(secret)));
  assert.equal((await recentAudit(OTHER_ADMIN, 10)).length, 0, 'another tenant sees nothing');
  await assert.rejects(recentAudit(OPERATOR), /admins/);

  const rows = await mainTable.query({ pk: keys.audit(ADMIN, '', '').PK });
  assert.ok(!JSON.stringify(rows).includes('Jane'), 'the arguments themselves are not kept');
  const expiresAt = rows[0].expiresAt as number;
  assert.ok(expiresAt > 1e9 && expiresAt < 1e11, 'epoch SECONDS - TTL ignores milliseconds silently');
  assert.equal(hashArgs({ a: 1, b: { c: 2, d: 3 } }), hashArgs({ b: { d: 3, c: 2 }, a: 1 }), 'key order does not change the hash');
});

// ---------------------------------------------------------------------------
// Found in review: concurrency, stale sessions, ids, depth
// ---------------------------------------------------------------------------

test('six parallel calls through one client all arrive - the session is busy, and the client queues rather than races', async () => {
  // A server that is busy while a call runs, as AgentCore is per session:
  // anything arriving meanwhile is -32005.
  let busy = false;
  const fetchImpl = serverFetch([], undefined, (body) => {
    if (body.method !== 'tools/call') return undefined;
    if (busy) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: SESSION_BUSY, message: 'Session operation in progress' } }), { status: 200 });
    return undefined;
  });
  const slow: typeof fetch = async (input, init) => {
    const isCall = String(init?.body).includes('"tools/call"');
    if (isCall && !busy) { busy = true; await new Promise((r) => setTimeout(r, 15)); busy = false; }
    return fetchImpl(input, init);
  };
  // Retries that do not wait: without the queue, the losers exhaust them in lockstep.
  const client = createMcpToolProvider({ url: 'https://mcp.test/mcp', token: 'tok-op', fetch: slow, sleep: async () => {} });
  const answers = await Promise.all(Array.from({ length: 6 }, () => client.call('listOpenIncidents', {})));
  assert.ok(answers.every((a) => !a.startsWith('ERROR')), answers.filter((a) => a.startsWith('ERROR')).join(' | '));
});

test('request ids never repeat within a resumed session: each client prefixes its own', async () => {
  const sent: Sent[] = [];
  const a = createMcpToolProvider({ url: 'https://mcp.test/mcp', token: 'tok-op', fetch: serverFetch(sent) });
  await a.list();
  const b = createMcpToolProvider({ url: 'https://mcp.test/mcp', token: 'tok-op', fetch: serverFetch(sent), sessionId: a.sessionId });
  await b.list();
  const ids = sent.map((s) => s.body.id).filter((id) => id !== undefined);
  assert.equal(new Set(ids).size, ids.length, 'no id twice: ' + ids.join(', '));
});

test('a session the server no longer knows (404) is replaced once - including on a resumed client\'s first request', async () => {
  const seen: string[] = [];
  const base = serverFetch();
  const fetchImpl: typeof fetch = async (input, init) => {
    const sid = (init?.headers as Record<string, string>)['Mcp-Session-Id'];
    seen.push(sid ?? '(none)');
    if (sid === 'stale-session') return new Response('session not found', { status: 404 });
    return base(input, init);
  };
  const renewed: string[] = [];
  const client = createMcpToolProvider({
    url: 'https://mcp.test/mcp', token: 'tok-op', fetch: fetchImpl, sessionId: 'stale-session', onSession: (id) => renewed.push(id),
  });
  assert.ok((await client.list()).length > 0);
  assert.equal(seen[0], 'stale-session');
  assert.equal(seen[1], '(none)', 'initialize retried WITHOUT the dead session id');
  assert.deepEqual(renewed, ['agentcore-assigned-session-0123456789abcdef'], 'and the caller is told the new one');
});

test('arguments nested deeper than any tool takes are refused before anything runs - and hashing never throws', async () => {
  let deep: unknown = 'x';
  for (let i = 0; i < 20_000; i++) deep = [deep];
  let audited = 0;
  const out = await handleMcpMessage(rpc(40, 'tools/call', { name: 'searchRunbooks', arguments: { query: deep } }), OPERATOR,
    { audit: async () => { audited++; } });
  assert.ok(out && 'error' in out);
  assert.equal(out.error.code, RPC.invalidParams);
  assert.equal(audited, 0, 'nothing ran, so nothing to audit');
  assert.doesNotThrow(() => hashArgs({ q: deep as never }), 'a hash can never overflow the stack');
});

test('two first requests at once ingest the runbooks ONCE - not 50 chunks where there should be 25', async () => {
  const { knowledgeBase } = await import('../knowledge-base.ts');
  const one: Principal = { ...OPERATOR, tenantId: 'ingest-once-a' };
  const two: Principal = { ...OPERATOR, tenantId: 'ingest-once-b' };
  let before = knowledgeBase.size;
  await prepareToolWorld(one);
  const single = knowledgeBase.size - before;
  before = knowledgeBase.size;
  await Promise.all([prepareToolWorld(two), prepareToolWorld(two)]);
  assert.equal(knowledgeBase.size - before, single);
});
