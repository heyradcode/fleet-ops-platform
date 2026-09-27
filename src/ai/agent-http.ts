/**
 * `POST /invocations`, over any response object: JSON, or a stream of events.
 *
 * Lifted out of the AgentCore entry point (infra/terraform/agentcore/
 * agent-entry.ts) so the decisions that are easy to get wrong - when the
 * stream opens, what a failure's status is - are tested rather than trusted.
 * The entry passes Node's ServerResponse, which already has this shape.
 *
 * STREAMING when the body says `"stream": true`: one server-sent event per
 * trace step as it happens, then the result. A body flag, not an Accept
 * header, because AgentCore forwards only allowlisted headers, and a header
 * that silently never arrived would turn streaming off with no error.
 *
 * The stream opens on the FIRST STEP, never before. A request refused before
 * any step - a bad token, a malformed question - gets its real status and a
 * JSON body. A 200 event-stream whose content then said "401" would hide the
 * status from the browser, from AgentCore's metrics, and from anyone reading
 * logs by status code.
 */
import { handleAgentInvocation, type InvocationDeps } from './agent-invocation.ts';
import { log } from '../platform/logger.ts';

export type ResponseSink = {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(): unknown;
};

export type StreamEvent =
  | { type: 'step'; step: unknown }
  | { type: 'result'; result: unknown }
  | { type: 'error'; status: number; error: string };

export async function serveInvocation(
  req: { authorization: string | undefined; body: string },
  deps: Omit<InvocationDeps, 'onStep'>,
  res: ResponseSink,
): Promise<void> {
  let wantsStream = false;
  try { wantsStream = (JSON.parse(req.body) as { stream?: unknown }).stream === true; } catch { /* the handler reports it */ }

  let streaming = false;
  const event = (e: StreamEvent) => {
    if (!streaming) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      streaming = true;
    }
    res.write('data: ' + JSON.stringify(e) + '\n\n');
  };
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify(body));
    res.end();
  };

  try {
    const out = await handleAgentInvocation(req, {
      ...deps,
      onStep: wantsStream ? (step) => event({ type: 'step', step }) : undefined,
    });
    if (!streaming) return json(out.status, out.body);
    event(out.status === 200
      ? { type: 'result', result: out.body }
      : { type: 'error', status: out.status, error: (out.body as { error: string }).error });
    res.end();
  } catch (err) {
    log.error('agent: request failed', { error: err instanceof Error ? err.message : String(err) });
    if (!streaming) return json(500, { error: 'The assistant failed. Try again.' });
    event({ type: 'error', status: 500, error: 'The assistant failed. Try again.' });
    res.end();
  }
}
