/**
 * The Claude adapter against a fake client: the request it sends, what it
 * does with thinking blocks, and the one-shot fallback on a refusal. No AWS.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeInvoker, type MessagesClient } from './bedrock.sdk.ts';
import { invokeModel, resetModelInvoker, setModelInvoker } from './bedrock.ts';

afterEach(() => resetModelInvoker());

function fakeClient(replies: Array<Record<string, unknown>>) {
  const sent: Array<Record<string, unknown>> = [];
  const client: MessagesClient = {
    messages: {
      async create(body) {
        sent.push(body);
        const next = replies.shift();
        if (!next) throw new Error('no more replies');
        return next;
      },
    },
  };
  return { client, sent };
}

const reply = (stop_reason: string, content: unknown[], tokens = [10, 5]) =>
  ({ stop_reason, content, usage: { input_tokens: tokens[0], output_tokens: tokens[1] } });

test('sends the Messages API shape: model, system, messages, tools, max_tokens', async () => {
  const { client, sent } = fakeClient([reply('end_turn', [{ type: 'text', text: 'ok' }])]);
  const invoke = createClaudeInvoker({ model: 'anthropic.claude-opus-5', client });
  const tools = [{ name: 't', description: 'd', input_schema: { type: 'object' as const, properties: {} } }];
  await invoke({ system: 'S', messages: [{ role: 'user', content: 'q' }], tools });
  assert.deepEqual(sent[0], {
    model: 'anthropic.claude-opus-5', max_tokens: 16000, system: 'S',
    messages: [{ role: 'user', content: 'q' }], tools,
  });
});

test('thinking blocks come back untouched, so the loop can send them back', async () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 'sig-abc' },
    { type: 'tool_use', id: 'tu1', name: 't', input: {} },
  ];
  const { client } = fakeClient([reply('tool_use', content)]);
  const r = await createClaudeInvoker({ model: 'm', client })({ system: '', messages: [{ role: 'user', content: 'q' }] });
  assert.deepEqual(r.content, content);
});

test('a refusal is retried ONCE on the fallback model, and both calls are counted', async () => {
  const { client, sent } = fakeClient([
    reply('refusal', [], [100, 1]),
    reply('end_turn', [{ type: 'text', text: 'answered' }], [100, 20]),
  ]);
  const invoke = createClaudeInvoker({ model: 'anthropic.claude-opus-5', fallbackModel: 'anthropic.claude-opus-4-8', client });
  const r = await invoke({ system: '', messages: [{ role: 'user', content: 'q' }] });
  assert.deepEqual(sent.map((b) => b.model), ['anthropic.claude-opus-5', 'anthropic.claude-opus-4-8']);
  assert.equal(r.stop_reason, 'end_turn');
  assert.deepEqual(r.usage, { input_tokens: 200, output_tokens: 21 });
});

test('no fallback configured: the refusal is returned for the loop to report', async () => {
  const { client, sent } = fakeClient([reply('refusal', [])]);
  const r = await createClaudeInvoker({ model: 'm', client })({ system: '', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(r.stop_reason, 'refusal');
  assert.equal(sent.length, 1);
});

test('registered, it is what invokeModel calls - the agent loop never knows', async () => {
  const { client } = fakeClient([reply('end_turn', [{ type: 'text', text: 'from claude' }])]);
  setModelInvoker(createClaudeInvoker({ model: 'm', client }));
  const r = await invokeModel({ system: '', messages: [{ role: 'user', content: 'q' }] });
  assert.deepEqual(r.content, [{ type: 'text', text: 'from claude' }]);
});
