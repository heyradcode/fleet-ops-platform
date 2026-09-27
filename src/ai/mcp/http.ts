/**
 * ---------------------------------------------------------------------------
 * MCP over streamable HTTP: `POST /mcp`, stateless, JSON responses
 * ---------------------------------------------------------------------------
 * The transport half of the server, over the same `ResponseSink` the agent's
 * entry point uses, so the Node shell (infra/terraform/agentcore/
 * mcp-entry.ts) is a few lines and everything that can be wrong is tested.
 *
 * THE ORDER IS THE WEBHOOK RULE: authenticate, THEN parse. Parsing first runs
 * a parser on unauthenticated input and tells a caller with no token whether
 * their body was well-formed. AgentCore's JWT authorizer has already checked
 * signature, issuer, expiry and client_id before this runs; the token is
 * verified AGAIN with all seven checks, for the reason agent-invocation.ts
 * gives - `token_use` and the tenant claim are not AgentCore's to check, and
 * the tenant claim is what every tool scopes by.
 *
 * What the spec (2025-06-18, "Streamable HTTP") asks, and where it is done:
 *   - one JSON-RPC message per POST; a batch (array) is refused - 400
 *   - Accept must list application/json AND text/event-stream - 406
 *   - an unsupported MCP-Protocol-Version header - 400; none: assume 2025-03-26
 *   - a notification or a response from the client - 202, no body
 *   - a request - 200 application/json. Never SSE: no tool here streams, and
 *     a JSON answer is one the client can read with no stream parser.
 *   - GET (the server-to-client stream) and DELETE (end session) - 405: this
 *     server sends nothing unprompted and keeps no session to end.
 * `Mcp-Session-Id` is accepted and ignored. AgentCore sets it and routes on
 * it; there is nothing here for it to name.
 */
import type { Principal } from '../../platform/types.ts';
import type { ResponseSink } from '../agent-http.ts';
import { log } from '../../platform/logger.ts';
import {
  handleMcpMessage, rpcError, RPC, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION,
  type JsonRpcRequest, type McpServerDeps,
} from './server.ts';

export type McpHttpRequest = {
  method: string;
  /** Lower-cased header names, as Node gives them. */
  headers: Record<string, string | undefined>;
  body: string;
};

export type McpHttpDeps = McpServerDeps & {
  /** Access token -> Principal, or throw. RS256 against the pool's JWKS in AgentCore. */
  verify: (token: string) => Promise<Principal>;
};

/** A request body larger than this is not a tool call. */
export const MAX_MCP_BODY_CHARS = 64 * 1024;

function send(res: ResponseSink, status: number, body?: unknown, extra: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, extra);
  } else {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
    res.write(JSON.stringify(body));
  }
  res.end();
}

export async function serveMcp(req: McpHttpRequest, deps: McpHttpDeps, res: ResponseSink): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, rpcError(null, RPC.invalidRequest, 'Only POST: this server keeps no stream and no session.'), { Allow: 'POST' });
    return;
  }

  // 1. Who - before anything about the body is looked at.
  const header = req.headers.authorization ?? '';
  let principal: Principal;
  try {
    if (!header.startsWith('Bearer ')) {
      // AgentCore authorised this request, so no header here means
      // request_header_allowlist lacks Authorization - say so in the log.
      log.warn('mcp: no bearer token reached the server - is Authorization in request_header_allowlist?');
      throw new Error('no bearer token');
    }
    principal = await deps.verify(header.slice('Bearer '.length));
  } catch (err) {
    if (header) log.warn('mcp: token rejected', { reason: err instanceof Error ? err.message : String(err) });
    send(res, 401, rpcError(null, RPC.unauthorized, 'Unauthorized'), { 'WWW-Authenticate': 'Bearer' });
    return;
  }

  // 2. Can the client read what we send?
  const accept = req.headers.accept ?? '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    send(res, 406, rpcError(null, RPC.invalidRequest, 'Accept must include application/json and text/event-stream.'));
    return;
  }

  // 3. A version we speak? An unknown one is refused rather than guessed at.
  const version = req.headers['mcp-protocol-version'] ?? DEFAULT_PROTOCOL_VERSION;
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    send(res, 400, rpcError(null, RPC.invalidRequest, 'Unsupported MCP-Protocol-Version: ' + version));
    return;
  }

  // 4. Only now, the body.
  if (req.body.length > MAX_MCP_BODY_CHARS) {
    send(res, 413, rpcError(null, RPC.invalidRequest, 'Request too large.'));
    return;
  }
  let msg: unknown;
  try {
    msg = JSON.parse(req.body);
  } catch {
    send(res, 400, rpcError(null, RPC.parseError, 'Parse error'));
    return;
  }
  if (Array.isArray(msg)) {
    // Batching was in 2025-03-26 and removed in 2025-06-18; nobody needs it
    // for a dozen read tools, and one message per POST keeps the audit and
    // the error handling one-to-one.
    send(res, 400, rpcError(null, RPC.invalidRequest, 'Batches are not supported: one message per POST.'));
    return;
  }
  if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
    send(res, 400, rpcError(null, RPC.invalidRequest, 'Not a JSON-RPC 2.0 message.'));
    return;
  }
  const m = msg as Partial<JsonRpcRequest> & { result?: unknown; error?: unknown };

  // A response from the client (we never ask it anything) or a notification: 202.
  if (typeof m.method !== 'string') {
    send(res, 202);
    return;
  }
  if (m.id !== undefined && typeof m.id !== 'string' && typeof m.id !== 'number') {
    send(res, 400, rpcError(null, RPC.invalidRequest, 'id must be a string or a number.'));
    return;
  }

  try {
    const out = await handleMcpMessage(m as JsonRpcRequest, principal, deps);
    if (out === undefined) send(res, 202);
    else send(res, 200, out);
  } catch (err) {
    // Detail to the log, never to the caller.
    log.error('mcp: request failed', { method: m.method, error: err instanceof Error ? err.message : String(err) });
    send(res, 200, rpcError(m.id ?? null, RPC.internalError, 'Internal error'));
  }
}
