/**
 * The AgentCore invocation handler, with the scripted model and the
 * in-memory table: the token checked again, the request validated, the
 * tools bounded to the caller - and nothing that writes.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import type { Principal } from '../platform/types.ts';
import { setRunbooks } from '../platform/runbook-loader.ts';
import { loadRunbooksFromDisk } from '../platform/runbook-loader.node.ts';
import { handleAgentInvocation, MAX_QUESTION_CHARS, type InvocationRequest } from './agent-invocation.ts';
import type { AgentResult } from './agent-core.ts';

const OPERATOR: Principal = {
  sub: 'op', email: 'op@acme-networks.com', tenantId: 'acme-networks',
  roles: ['operator'], scope: { kind: 'site', siteId: 'dal-01' }, identityProvider: 'cognito',
};
const ADMIN: Principal = { ...OPERATOR, sub: 'ad', roles: ['admin'], scope: { kind: 'tenant' } };

const TOKENS: Record<string, Principal> = { 'tok-op': OPERATOR, 'tok-admin': ADMIN };
const verify = async (token: string) => {
  const p = TOKENS[token];
  if (!p) throw new Error('no tenant claim');
  return p;
};

/** `token: null` sends no Authorization header at all - `undefined` would take the default. */
const ask = (question: unknown, token: string | null = 'tok-op'): InvocationRequest => ({
  authorization: token === null ? undefined : 'Bearer ' + token,
  body: JSON.stringify({ question }),
});

before(() => setRunbooks(loadRunbooksFromDisk()));

test('no forwarded Authorization header, or a token the verifier rejects: 401, nothing run', async () => {
  for (const r of [ask('why is dal-01 down?', null), ask('why is dal-01 down?', 'tok-id-token')]) {
    const res = await handleAgentInvocation(r, { verify });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
  }
});

test('the request is validated before anything runs', async () => {
  for (const body of ['not json', '{}', JSON.stringify({ question: '   ' }), JSON.stringify({ question: 42 })]) {
    const res = await handleAgentInvocation({ authorization: 'Bearer tok-op', body }, { verify });
    assert.equal(res.status, 400, body);
  }
  const long = await handleAgentInvocation(ask('x'.repeat(MAX_QUESTION_CHARS + 1)), { verify });
  assert.equal(long.status, 400);
});

test('a question gets an answer with its trace - the same loop the board runs', async () => {
  const res = await handleAgentInvocation(ask('Why is the Dallas core switch unreachable? What should I do?'), { verify });
  assert.equal(res.status, 200);
  const result = res.body as AgentResult;
  assert.ok(result.answer.length > 0);
  assert.ok(result.trace.some((s) => s.kind === 'tool'), 'it used its tools');
});

test('the deployed agent is READ-ONLY: even an admin is not offered a tool that pages someone', async () => {
  const res = await handleAgentInvocation(ask('Open a critical incident for the Dallas core switch.', 'tok-admin'), { verify });
  assert.equal(res.status, 200);
  const result = res.body as AgentResult;
  const writes = result.trace.filter((s) => s.kind === 'tool' && /^(openIncident|suppressAlarm)\(/.test(s.detail));
  for (const w of writes) assert.ok(w.detail.endsWith('-> error'), 'refused if attempted: ' + w.detail);
  assert.ok(!/Opened inc/.test(result.answer), 'no incident was opened');
});

test('asking twice does not ingest the runbooks twice', async () => {
  const { knowledgeBase } = await import('./knowledge-base.ts');
  await handleAgentInvocation(ask('How do I fix a link down?'), { verify });
  const size = knowledgeBase.size;
  await handleAgentInvocation(ask('How do I fix a link down?'), { verify });
  assert.equal(knowledgeBase.size, size);
});

test('a model that names a tool it was NOT offered is refused by the loop, not trusted', async () => {
  const { setModelInvoker, resetModelInvoker } = await import('../aws/bedrock.ts');
  // A real model can call a tool it was never shown. This one insists.
  let turn = 0;
  setModelInvoker(async () => (turn++ === 0
    ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'openIncident', input: { title: 'x', severity: 'critical', siteId: 'dal-01', deviceIds: [] } }], usage: { input_tokens: 1, output_tokens: 1 } }
    : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  try {
    const res = await handleAgentInvocation(ask('page someone', 'tok-admin'), { verify });
    const result = res.body as AgentResult;
    const call = result.trace.find((s) => s.detail.startsWith('openIncident('));
    assert.ok(call, 'the model did try');
    assert.ok(call.detail.endsWith('-> error'), 'and the loop refused it');
  } finally {
    resetModelInvoker();
  }
});

// ---------------------------------------------------------------------------
// Conversations: kept in the session's microVM, per verified user
// ---------------------------------------------------------------------------

import { HISTORY_TURNS } from './agent-invocation.ts';
import type { Message } from '../aws/bedrock.ts';

/** A model that answers "A<n>" and records every request it was sent. */
async function withRecordingModel(run: (seen: Message[][]) => Promise<void>) {
  const { setModelInvoker, resetModelInvoker } = await import('../aws/bedrock.ts');
  const seen: Message[][] = [];
  setModelInvoker(async (req) => {
    seen.push([...req.messages]);   // a copy: the loop appends to the same array afterwards
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'A' + seen.length }], usage: { input_tokens: 1, output_tokens: 1 } };
  });
  try { await run(seen); } finally { resetModelInvoker(); }
}

const person = (sub: string): Principal => ({ ...OPERATOR, sub });
const askAs = (p: Principal, question: string, extra: Record<string, unknown> = {}) => {
  TOKENS['tok-' + p.sub] = p;
  return handleAgentInvocation({ authorization: 'Bearer tok-' + p.sub, body: JSON.stringify({ question, ...extra }) }, { verify });
};
const texts = (messages: Message[]) => messages.map((m) => m.role + ':' + (typeof m.content === 'string' ? m.content : '[blocks]'));

test('a follow-up carries the conversation so far', async () => {
  await withRecordingModel(async (seen) => {
    const p = person('conv-follow');
    await askAs(p, 'Why is dal-01 down?');
    await askAs(p, 'And what is above it?');
    assert.deepEqual(texts(seen[1]), ['user:Why is dal-01 down?', 'assistant:A1', 'user:And what is above it?']);
  });
});

test("one person's conversation is never another's, even in the same microVM", async () => {
  await withRecordingModel(async (seen) => {
    await askAs(person('conv-alice'), 'my secret question');
    await askAs(person('conv-bob'), 'hello');
    assert.deepEqual(texts(seen[1]), ['user:hello']);
  });
});

test('newConversation starts over; history is capped', async () => {
  await withRecordingModel(async (seen) => {
    const p = person('conv-cap');
    for (let i = 1; i <= HISTORY_TURNS + 2; i++) await askAs(p, 'q' + i);
    const last = seen[seen.length - 1];
    assert.equal(last.length, HISTORY_TURNS * 2 + 1, 'only the last ' + HISTORY_TURNS + ' turns');
    await askAs(p, 'fresh start', { newConversation: true });
    assert.deepEqual(texts(seen[seen.length - 1]), ['user:fresh start']);
  });
});

test('a refused answer is not remembered as context', async () => {
  const { setModelInvoker, resetModelInvoker } = await import('../aws/bedrock.ts');
  const seen: Message[][] = [];
  let n = 0;
  setModelInvoker(async (req) => {
    seen.push([...req.messages]);   // a copy: the loop appends to the same array afterwards
    return n++ === 0
      ? { stop_reason: 'refusal', content: [], usage: { input_tokens: 1, output_tokens: 0 } }
      : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
  });
  try {
    const p = person('conv-refused');
    await askAs(p, 'something declined');
    await askAs(p, 'next');
    assert.deepEqual(texts(seen[1]), ['user:next']);
  } finally { resetModelInvoker(); }
});

test('the answer says where it came from: AgentCore, the model, and the turn', async () => {
  const p = person('served-by');
  TOKENS['tok-' + p.sub] = p;
  const ask2 = (question: string, extra: Record<string, unknown> = {}) => handleAgentInvocation(
    { authorization: 'Bearer tok-' + p.sub, body: JSON.stringify({ question, ...extra }) },
    { verify, model: 'anthropic.claude-opus-5' },
  );
  const first = (await ask2('How do I fix a link down?')).body as AgentResult;
  const second = (await ask2('And after that?')).body as AgentResult;
  const fresh = (await ask2('Start over', { newConversation: true })).body as AgentResult;
  assert.deepEqual(first.servedBy, { host: 'agentcore', model: 'anthropic.claude-opus-5', turn: 1 });
  assert.equal(second.servedBy?.turn, 2);
  assert.equal(fresh.servedBy?.turn, 1);
});
