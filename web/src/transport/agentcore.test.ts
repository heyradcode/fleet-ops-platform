/**
 * The board's AgentCore caller, against a fake AgentCore that forwards to
 * the REAL invocation handler - so the URL, the headers, the session rules
 * and the error mapping are pinned end to end, with no AWS.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentCoreAsker, invocationUrl } from './agentcore.ts';
import { BoardApiError } from './api.ts';
import { localAuth } from '../auth/local.ts';
import { setClock, fixedClock } from '../../../src/platform/clock.ts';
import { setRunbooks } from '../../../src/platform/runbook-loader.ts';
import { loadRunbooksFromDisk } from '../../../src/platform/runbook-loader.node.ts';
import { handleAgentInvocation } from '../../../src/ai/agent-invocation.ts';
import type { Principal } from '../../../src/platform/types.ts';

const ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/netpulse_demo_agent-AbC123';

before(() => {
  setClock(fixedClock());
  setRunbooks(loadRunbooksFromDisk());
});

/** Tokens the local issuer handed out -> principals. The pool, in miniature. */
const issued = new Map<string, Principal>();
const seen: Array<{ url: string; headers: Record<string, string> }> = [];

/** AgentCore, as far as the board can tell: JWT check, header allowlist, 424 on an agent error. */
const fakeAgentCore: typeof fetch = async (input, init) => {
  const headers = init?.headers as Record<string, string>;
  seen.push({ url: String(input), headers });
  const token = headers.authorization?.replace(/^Bearer /, '') ?? '';
  if (!issued.has(token)) return new Response('{"message":"Unauthorized"}', { status: 401, headers: { 'x-amzn-errortype': 'UnauthorizedException' } });
  const out = await handleAgentInvocation({ authorization: headers.authorization, body: String(init?.body) }, {
    verify: async (t) => issued.get(t)!,
  });
  if (out.status >= 400) return new Response('{}', { status: 424, headers: { 'x-amzn-errortype': 'RuntimeClientError' } });
  return new Response(JSON.stringify(out.body), { status: 200 });
};

async function signIn(email: string) {
  const s = await localAuth.signIn(email);
  issued.set(s.token, s.principal);
  return s;
}

test('the URL is the runtime endpoint: region from the ARN, ARN escaped, DEFAULT qualifier', () => {
  assert.equal(invocationUrl(ARN),
    'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/' + encodeURIComponent(ARN) + '/invocations?qualifier=DEFAULT');
  assert.throws(() => invocationUrl('arn:aws:lambda:us-east-1:1:function:x'), /not an AgentCore runtime ARN/);
});

test('a question goes out with the token and a session id, and the answer comes back', async () => {
  const s = await signIn('lead@netpulse.io');
  const asker = createAgentCoreAsker(ARN, fakeAgentCore);
  asker.setToken(s.token);
  const result = await asker.ask('Why is the Dallas core switch unreachable?');
  assert.ok(result.answer.length > 0);
  const last = seen[seen.length - 1];
  assert.equal(last.headers.authorization, 'Bearer ' + s.token);
  assert.ok(last.headers['x-amzn-bedrock-agentcore-runtime-session-id'].length >= 33, 'AgentCore wants 33+ characters');
});

test('one session per signed-in person: kept across questions, replaced when the token changes', async () => {
  const a = await signIn('lead@netpulse.io');
  const b = await signIn('operator@acme-networks.com');
  const asker = createAgentCoreAsker(ARN, fakeAgentCore);
  asker.setToken(a.token);
  const first = asker.sessionId;
  await asker.ask('How do I fix a link down?');
  assert.equal(asker.sessionId, first, 'follow-ups reuse the warm microVM');
  asker.setToken(b.token);
  assert.notEqual(asker.sessionId, first, "the next person never inherits the last one's microVM");
});

test('session ids come from the CSPRNG, not the seeded demo uuid', () => {
  const ids = new Set(Array.from({ length: 5 }, () => createAgentCoreAsker(ARN, fakeAgentCore).sessionId));
  assert.equal(ids.size, 5);
});

test('failures say what happened: expired token, agent error, no token at all', async () => {
  const asker = createAgentCoreAsker(ARN, fakeAgentCore);
  await assert.rejects(asker.ask('q'), /Sign in first/);

  asker.setToken('not-a-token-the-pool-issued');
  await assert.rejects(asker.ask('q'), (e: unknown) => e instanceof BoardApiError && e.status === 401 && /sign in again/.test(e.message));

  const s = await signIn('lead@netpulse.io');
  asker.setToken(s.token);
  await assert.rejects(asker.ask('x'.repeat(5000)), (e: unknown) => e instanceof BoardApiError && e.status === 424);
});

test('a session still starting up (409 RetryableConflict) is retried, not shown as an error', async () => {
  const s = await signIn('lead@netpulse.io');
  let calls = 0;
  const startingUp: typeof fetch = async (input, init) => {
    calls++;
    if (calls <= 2) return new Response('{}', { status: 409, headers: { 'x-amzn-errortype': 'RetryableConflictException' } });
    return fakeAgentCore(input, init);
  };
  const waits: number[] = [];
  const asker = createAgentCoreAsker(ARN, startingUp, undefined, async (ms) => { waits.push(ms); });
  asker.setToken(s.token);
  const result = await asker.ask('How do I fix a link down?');
  assert.ok(result.answer.length > 0);
  assert.deepEqual(waits, [250, 500], 'backed off, then got through');
});

test('a 409 that is NOT retryable is reported, not retried', async () => {
  const s = await signIn('lead@netpulse.io');
  let calls = 0;
  const conflict: typeof fetch = async () => { calls++; return new Response('{}', { status: 409, headers: { 'x-amzn-errortype': 'ConflictException' } }); };
  const asker = createAgentCoreAsker(ARN, conflict, undefined, async () => {});
  asker.setToken(s.token);
  await assert.rejects(asker.ask('q'), /still starting up/);
  assert.equal(calls, 1);
});

test('newConversation sends the flag ONCE, then questions carry on as normal', async () => {
  const s = await signIn('lead@netpulse.io');
  const bodies: string[] = [];
  const recording: typeof fetch = async (input, init) => { bodies.push(String(init?.body)); return fakeAgentCore(input, init); };
  const asker = createAgentCoreAsker(ARN, recording);
  asker.setToken(s.token);
  await asker.ask('first');
  asker.newConversation();
  await asker.ask('second');
  await asker.ask('third');
  assert.deepEqual(bodies.map((b) => JSON.parse(b).newConversation ?? false), [false, true, false]);
});

// ---------------------------------------------------------------------------
// Streaming: the real serveInvocation, cut into awkward network chunks
// ---------------------------------------------------------------------------

import { serveInvocation } from '../../../src/ai/agent-http.ts';

/** AgentCore forwarding the agent's response - in 7-byte pieces, so events split mid-way. */
const streamingAgentCore: typeof fetch = async (_input, init) => {
  const headers = init?.headers as Record<string, string>;
  const token = headers.authorization?.replace(/^Bearer /, '') ?? '';
  if (!issued.has(token)) return new Response('{}', { status: 401 });
  let status = 0; let contentType = ''; let text = '';
  await serveInvocation({ authorization: headers.authorization, body: String(init?.body) }, {
    verify: async (t) => issued.get(t)!,
  }, {
    writeHead(s, h) { status = s; contentType = h['Content-Type']; },
    write(chunk) { text += chunk; },
    end() {},
  });
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': contentType } });
};

test('streamed: each step reaches the board as it happens, and the result matches them', async () => {
  const s = await signIn('lead@netpulse.io');
  const asker = createAgentCoreAsker(ARN, streamingAgentCore);
  asker.setToken(s.token);
  const live: number[] = [];
  const result = await asker.ask('How do I fix a link down?', (step) => live.push(step.step));
  assert.ok(live.length >= 3, 'several steps arrived before the answer');
  assert.deepEqual(live, result.trace.map((t) => t.step));
});

test('a stream that ends without a result is an error, not an empty answer', async () => {
  const s = await signIn('lead@netpulse.io');
  const cut: typeof fetch = async () => new Response(
    'data: {"type":"step","step":{"step":1,"kind":"guardrail","detail":"x","ms":0}}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const asker = createAgentCoreAsker(ARN, cut);
  asker.setToken(s.token);
  await assert.rejects(asker.ask('q', () => {}), /stopped before it finished/);
});
