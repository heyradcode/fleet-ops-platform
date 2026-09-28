/**
 * The agent and its tools in SEPARATE PROCESSES, as they are deployed.
 *
 * mcp.test.ts runs both ends in one process, which proves the protocol but
 * hides a whole class of mistake: anything the agent's side quietly relies on
 * - an estate loaded, runbooks ingested, a store filled - is there because the
 * server's side put it there, in the same memory. Deployed, they are two
 * microVMs, and that reliance is a wrong answer nobody sees in a test.
 *
 * So this starts the real local server (scripts/mcp-local.ts) as a child
 * process on a free port, and runs the agent here, where nothing has prepared
 * the world. The knowledge base staying EMPTY in this process while the
 * answer cites a runbook is the proof the tools ran over there.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { setClock, fixedClock } from '../../platform/clock.ts';
import { signDemoToken, verifyToken } from '../../auth/cognito-jwt-verifier.ts';
import { setRunbooks } from '../../platform/runbook-loader.ts';
import { loadRunbooksFromDisk } from '../../platform/runbook-loader.node.ts';
import { knowledgeBase } from '../knowledge-base.ts';
import { handleAgentInvocation } from '../agent-invocation.ts';
import type { AgentResult } from '../agent-core.ts';
import { createMcpToolProvider } from './client.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STARTUP_MS = 30_000;

let child: ChildProcess | undefined;
let url = '';

before(async () => {
  // --no-seed: this process's table is empty too, so the in-process run
  // below computes over the same (empty) store and the answers can be compared.
  child = spawn(process.execPath, ['scripts/mcp-local.ts', '--port=0', '--quiet', '--no-seed'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d: Uint8Array) => { stderr += String(d); });
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mcp-local did not start in ' + STARTUP_MS + ' ms:\n' + stderr)), STARTUP_MS);
    let stdout = '';
    // Keep draining after the first line: an unread pipe fills and blocks the child.
    child?.stdout?.on('data', (d: Uint8Array) => {
      stdout += String(d);
      const m = /MCP server: (http:\/\/\S+)/.exec(stdout);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child?.on('exit', (code) => { clearTimeout(timer); reject(new Error('mcp-local exited (' + String(code) + '):\n' + stderr)); });
  });
  // This side needs runbooks only for the in-process comparison run.
  setRunbooks(loadRunbooksFromDisk());
});

after(() => { child?.kill(); });

test('the agent here, its tools in another process: the same answer, and none of the world loaded here', async () => {
  // The demo's pinned clock, which is what the child's verifier checks against.
  setClock(fixedClock());
  const token = signDemoToken({
    sub: 'proc-operator', email: 'op@acme-networks.com',
    'custom:tenantId': 'acme-networks', 'cognito:groups': ['operator'], 'custom:site': 'dal-01',
  });
  const body = JSON.stringify({ question: 'Why is the Dallas core switch unreachable? What should I do?', newConversation: true });
  const verify = async (t: string) => verifyToken(t);

  assert.equal(knowledgeBase.size, 0, 'precondition: nothing ingested in this process');
  const remote = (await handleAgentInvocation(
    { authorization: 'Bearer ' + token, body },
    { verify, tools: (_p, tok) => createMcpToolProvider({ url, token: tok }) },
  )).body as AgentResult;

  assert.equal(remote.servedBy?.tools, 'mcp');
  assert.equal(remote.stoppedBecause, 'end_turn');
  const calls = remote.trace.filter((s) => s.kind === 'tool');
  assert.ok(calls.some((s) => s.detail.startsWith('searchRunbooks(')), 'it used the runbooks');
  assert.ok(calls.every((s) => !s.detail.endsWith('-> error')), 'no tool failed: ' + calls.map((s) => s.detail).join(' | '));
  assert.equal(knowledgeBase.size, 0, 'the runbooks were searched in the OTHER process - none were ingested here');

  // And the in-process route, over the same empty store, says the same thing.
  const local = (await handleAgentInvocation({ authorization: 'Bearer ' + token, body }, { verify })).body as AgentResult;
  assert.equal(local.servedBy?.tools, 'in-process');
  assert.equal(remote.answer, local.answer);
});

test('the child verifies every token itself: a valid one is listed read tools, a forged signature is a 401', async () => {
  setClock(fixedClock());
  const good = signDemoToken({ sub: 'proc-admin', 'custom:tenantId': 'acme-networks', 'cognito:groups': ['admin'] });
  const tools = await createMcpToolProvider({ url, token: good }).list();
  assert.ok(tools.some((t) => t.name === 'traceTopology'));
  assert.ok(!tools.some((t) => t.name === 'openIncident'), 'read tools only, admin or not');

  const forged = good.slice(0, good.lastIndexOf('.') + 1) + 'AAAA';
  await assert.rejects(createMcpToolProvider({ url, token: forged }).list(), /answered 401/);
});

test('DNS rebinding: a request addressed to, or sent from, a non-loopback name is refused before anything else', async () => {
  const { request } = await import('node:http');
  const port = Number(new URL(url).port);
  const send = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end('{}');
  });
  // A page whose own name was re-pointed at 127.0.0.1: the browser sends ITS host.
  assert.equal(await send({ host: 'rebound.attacker.example:' + port }), 403);
  // A loopback host, but a page elsewhere made the request.
  assert.equal(await send({ host: '127.0.0.1:' + port, origin: 'https://attacker.example' }), 403);
  // A CLI client - loopback host, no Origin - gets past this check (and to the 401).
  assert.equal(await send({ host: '127.0.0.1:' + port }), 401);
});
