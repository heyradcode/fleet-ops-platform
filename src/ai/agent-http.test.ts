/**
 * POST /invocations over a fake response: JSON or a stream, and a refusal
 * always keeps its real status.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import type { Principal } from '../platform/types.ts';
import { setRunbooks } from '../platform/runbook-loader.ts';
import { loadRunbooksFromDisk } from '../platform/runbook-loader.node.ts';
import { serveInvocation, type ResponseSink, type StreamEvent } from './agent-http.ts';

const P: Principal = {
  sub: 'http-test', email: 'x@acme-networks.com', tenantId: 'acme-networks',
  roles: ['operator'], scope: { kind: 'site', siteId: 'dal-01' }, identityProvider: 'cognito',
};
const verify = async (t: string) => { if (t !== 'good') throw new Error('bad'); return P; };

function sink() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '', ended: false };
  const res: ResponseSink = {
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    write(chunk) { out.body += chunk; },
    end() { out.ended = true; },
  };
  return { out, res };
}
const events = (body: string) => body.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, '')) as StreamEvent);

before(() => setRunbooks(loadRunbooksFromDisk()));

test('without "stream": one JSON answer, as before', async () => {
  const { out, res } = sink();
  await serveInvocation({ authorization: 'Bearer good', body: JSON.stringify({ question: 'How do I fix a link down?' }) }, { verify }, res);
  assert.equal(out.status, 200);
  assert.equal(out.headers['Content-Type'], 'application/json');
  assert.ok(JSON.parse(out.body).answer);
  assert.ok(out.ended);
});

test('with "stream": every step as an event, in order, then the result', async () => {
  const { out, res } = sink();
  await serveInvocation({ authorization: 'Bearer good', body: JSON.stringify({ question: 'How do I fix a link down?', stream: true }) }, { verify }, res);
  assert.equal(out.headers['Content-Type'], 'text/event-stream');
  const evs = events(out.body);
  const last = evs[evs.length - 1];
  assert.equal(last.type, 'result');
  const steps = evs.filter((e) => e.type === 'step').map((e) => (e as { step: { step: number } }).step.step);
  const trace = (last as { result: { trace: Array<{ step: number }> } }).result.trace.map((t) => t.step);
  assert.deepEqual(steps, trace, 'the stream carried exactly the trace, as it happened');
  assert.ok(out.ended);
});

test('refused before any step, a streaming request still gets its REAL status as JSON', async () => {
  for (const [authorization, body, status] of [
    ['Bearer forged', JSON.stringify({ question: 'q', stream: true }), 401],
    ['Bearer good', JSON.stringify({ question: '', stream: true }), 400],
  ] as const) {
    const { out, res } = sink();
    await serveInvocation({ authorization, body }, { verify }, res);
    assert.equal(out.status, status);
    assert.equal(out.headers['Content-Type'], 'application/json', 'not a 200 event-stream hiding the status');
  }
});
