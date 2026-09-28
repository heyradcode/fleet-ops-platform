/**
 * ---------------------------------------------------------------------------
 * The MCP client: the agent's tools, from an MCP server, as the caller
 * ---------------------------------------------------------------------------
 * A ToolProvider (tool-provider.ts) that reaches its tools over streamable
 * HTTP. The deployed agent builds one per invocation with the caller's OWN
 * access token - the one AgentCore just accepted and the agent just verified
 * - so the MCP server scopes every tool to that person. The agent has no
 * identity of its own to lend: a client built with a service credential
 * would turn a Dallas operator's question into an answer about the whole
 * tenant. (This is also why the agent calls the MCP runtime directly rather
 * than through AgentCore Gateway: Gateway's outbound auth is IAM, an API key
 * or OAuth client credentials - the gateway's identity, not the user's.)
 *
 * What is easy to get wrong, and handled here:
 *   - the handshake. `initialize`, then `notifications/initialized`, then
 *     anything else - lazily, on first use, once per client.
 *   - either response shape. A server may answer a request with JSON or with
 *     an SSE stream; ours sends JSON, AgentCore's own examples stream.
 *   - `Mcp-Session-Id`. AgentCore assigns one and routes on it; sending it
 *     back keeps every call of this question in the same warm microVM.
 *   - `-32005 Session operation in progress`. AgentCore's answer when a
 *     session is busy. It arrives as a JSON-RPC ERROR with HTTP 200, so a
 *     client that only retries on status codes never retries it.
 *   - a failing tool is a RESULT. `isError: true` comes back as text starting
 *     "ERROR:" for the model to read; only transport failures throw, and the
 *     agent loop turns those into text too.
 *   - ONE CALL AT A TIME per client. The loop runs a turn's tool calls in
 *     parallel, but AgentCore serialises a session: the rest get -32005, and
 *     retrying them in lockstep lets at most one through per round - a real
 *     model asking for six tools at once got four answers and two errors.
 *     Queued here, they cost the same wall-clock and all arrive.
 *   - request ids are never reused within a session. A resumed session gets
 *     a new client, and a counter restarting at 1 would repeat ids the spec
 *     says must be unique - so each client prefixes its own.
 *   - a 404 on a request that carried a session id means the session is gone;
 *     the spec says start a new one. Once, then the error stands.
 */
import type { ToolSpec } from '../../aws/bedrock.ts';
import { parseSse } from '../../platform/sse.ts';
import type { ToolProvider } from '../tool-provider.ts';
import { SUPPORTED_PROTOCOL_VERSIONS, type JsonRpcResponse, type McpTool } from './server.ts';

/** What we ask for. The server may answer with an older version it speaks; we accept any we list. */
export const CLIENT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** AgentCore: "Session operation in progress". Retried; nothing else is. */
export const SESSION_BUSY = -32005;
const BUSY_RETRIES_MS = [250, 500, 1000, 2000];
/** More pages than this from a tools/list is a server that never stops. */
const MAX_LIST_PAGES = 10;

export class McpError extends Error {
  readonly code: number | undefined;
  readonly status: number | undefined;
  constructor(message: string, opts: { code?: number; status?: number } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = opts.code;
    this.status = opts.status;
  }
}

export type McpClientOptions = {
  url: string;
  /** The CALLER's access token. Never a service credential - see the header. */
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Resume a session this process already has (keeps the same warm microVM). */
  sessionId?: string;
  /** Told when the server assigns (or changes) the session, so the caller can resume it next time. */
  onSession?: (sessionId: string) => void;
  /** Reported, not acted on: the URL already decides where requests go. */
  route?: 'direct' | 'gateway';
};

export type McpToolProvider = ToolProvider & {
  /** The session the server (AgentCore) assigned, once one has been. */
  readonly sessionId: string | undefined;
  /** What `initialize` returned - name and version - once it has run. */
  readonly serverInfo: { name: string; version: string } | undefined;
};

export function createMcpToolProvider(opts: McpClientOptions): McpToolProvider {
  const fetchImpl = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let sessionId = opts.sessionId;
  let protocolVersion: string | undefined;
  let serverInfo: { name: string; version: string } | undefined;
  let nextId = 1;
  // Unique per client: getRandomValues, not the seeded uuid() - the demo
  // world reseeds, and every client would get the same prefix.
  const idPrefix = (() => { const b = new Uint8Array(4); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); })();
  let ready: Promise<void> | undefined;
  // The queue every list() and call() goes through - see the header.
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = tail.then(run, run);
    tail = next.then(() => undefined, () => undefined);
    return next;
  }

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: 'Bearer ' + opts.token,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    // Not on `initialize` itself - the version is what it negotiates.
    if (protocolVersion) h['MCP-Protocol-Version'] = protocolVersion;
    if (sessionId) h['Mcp-Session-Id'] = sessionId;
    return h;
  }

  /** POST one message. A notification resolves to undefined (202); a request to its response. */
  async function post(message: Record<string, unknown>): Promise<JsonRpcResponse | undefined> {
    const res = await fetchImpl(opts.url, { method: 'POST', headers: headers(), body: JSON.stringify(message) });
    const assigned = res.headers.get('mcp-session-id');
    if (assigned && assigned !== sessionId) {
      sessionId = assigned;
      opts.onSession?.(assigned);
    }

    if (res.status === 202) return undefined;
    if (!res.ok) {
      // The body of a failed request may be JSON-RPC (ours) or AgentCore's
      // own JSON. Neither is shown to the model beyond its first line.
      const text = await res.text().catch(() => '');
      throw new McpError('MCP server answered ' + res.status + (text ? ': ' + text.slice(0, 200) : ''), { status: res.status });
    }

    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (type.includes('text/event-stream')) {
      // The stream may carry the server's own notifications before the
      // answer; ours is the event whose id matches.
      const { events } = parseSse(text + '\n\n');
      const mine = events.find((e) => (e as { id?: unknown }).id === message.id);
      if (!mine) throw new McpError('MCP stream ended without a response to request ' + String(message.id));
      return mine as JsonRpcResponse;
    }
    return JSON.parse(text) as JsonRpcResponse;
  }

  /** A request, retried while AgentCore says the session is busy. Throws on any JSON-RPC error. */
  async function request(method: string, params: Record<string, unknown>, restartable = true): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const sentSession = sessionId;
      let out: JsonRpcResponse | undefined;
      try {
        out = await post({ jsonrpc: '2.0', id: idPrefix + '-' + String(nextId++), method, params });
      } catch (err) {
        // The session this client was resuming is gone: start a new one and
        // try once more. A RESUMED client meets this on its very first
        // request - initialize, carrying the stale id - so that is retried
        // bare; anything later re-handshakes first.
        if (restartable && sentSession && err instanceof McpError && err.status === 404) {
          sessionId = undefined;
          if (method === 'initialize') return request(method, params, false);
          protocolVersion = undefined;
          ready = undefined;
          await initialise();
          return request(method, params, false);
        }
        throw err;
      }
      if (!out) throw new McpError('MCP server sent no response to ' + method);
      if ('result' in out) return out.result;
      if (out.error.code === SESSION_BUSY && attempt < BUSY_RETRIES_MS.length) {
        await sleep(BUSY_RETRIES_MS[attempt]);
        continue;
      }
      throw new McpError(out.error.message, { code: out.error.code });
    }
  }

  function initialise(): Promise<void> {
    ready ??= (async () => {
      const result = await request('initialize', {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'netpulse-agent', version: '1.0.0' },
      }) as { protocolVersion?: string; serverInfo?: { name: string; version: string } };
      const agreed = result.protocolVersion ?? '';
      if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(agreed)) {
        // The spec: a client that does not speak the server's version SHOULD disconnect.
        throw new McpError('MCP server speaks protocol ' + (agreed || '(none)') + ', which this client does not');
      }
      protocolVersion = agreed;
      serverInfo = result.serverInfo;
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    // A failed handshake is retried by the next call, not cached forever.
    // (The caller awaits `ready` and sees the error; this only clears it.)
    void ready.catch(() => { ready = undefined; });
    return ready;
  }

  return {
    via: 'mcp',
    route: opts.route,
    get sessionId() { return sessionId; },
    get serverInfo() { return serverInfo; },

    list: () => serial(async (): Promise<ToolSpec[]> => {
      await initialise();
      const tools: ToolSpec[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await request('tools/list', cursor ? { cursor } : {}) as { tools?: McpTool[]; nextCursor?: string };
        for (const t of result.tools ?? []) {
          tools.push({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? { type: 'object', properties: {} } });
        }
        cursor = result.nextCursor;
        if (!cursor) return tools;
      }
      // Stopping quietly would offer the model a partial toolset with no sign
      // of it - the drainPages lesson. Say it.
      throw new McpError('MCP tools/list did not finish in ' + MAX_LIST_PAGES + ' pages');
    }),

    call: (name: string, input: Record<string, unknown>) => serial(async (): Promise<string> => {
      await initialise();
      let result: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      try {
        result = await request('tools/call', { name, arguments: input }) as typeof result;
      } catch (err) {
        // A JSON-RPC error (unknown tool, bad params) is something the model
        // can act on; a transport failure is rethrown for the loop to report.
        if (err instanceof McpError && err.code !== undefined) return 'ERROR: ' + err.message;
        throw err;
      }
      // Text blocks only - the platform's tools return nothing else, and a
      // non-text block from a future server is named rather than dropped.
      const text = (result.content ?? [])
        .map((c) => (c.type === 'text' ? c.text ?? '' : '[' + c.type + ' content omitted]'))
        .join('\n');
      if (result.isError && !text.startsWith('ERROR:')) return 'ERROR: ' + text;
      return text;
    }),
  };
}
