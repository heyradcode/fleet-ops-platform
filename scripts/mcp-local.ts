/**
 * The MCP tool server on localhost - for Claude Code, the MCP Inspector, curl.
 *
 *   pnpm mcp                        # http://127.0.0.1:8000/mcp
 *   pnpm mcp --port=8123
 *   pnpm mcp --no-seed              # an empty table: tools see the estate, no stored incidents
 *
 * The SAME server the AgentCore runtime runs (src/ai/mcp/http.ts), over the
 * in-memory table and the seeded demo world instead of DynamoDB and a pool:
 * nothing here needs an AWS account or the network. The table is filled by
 * the same code as `pnpm seed:aws` (scripts/seed-core.ts), so a question
 * answered here is answered the way the deployed tools would answer it. It prints three demo
 * tokens - an operator scoped to Dallas, a tenant-wide admin, and an HHS admin
 * who is also offered the comms tools - so the one thing MCP makes easy to
 * miss is visible from outside: the SAME server lists DIFFERENT tools, and
 * answers the same call differently, depending on whose token it is.
 *
 * LOOPBACK ONLY, and it refuses anything else. The tokens are HS256, signed
 * with the demo secret that is in this repository: anyone who can reach the
 * port can mint an admin token for any tenant. That is fine on 127.0.0.1 and
 * nowhere else. (The deployed server takes only RS256 tokens from the real
 * pool - see infra/terraform/agentcore/mcp-entry.ts.)
 *
 * Tokens are minted on the demo's PINNED clock, which is also what the
 * offline verifier checks them against, so they do not expire while it runs.
 * Every tool call is audited into the in-memory table, as on AWS, and logged
 * here so you can watch it happen.
 *
 * Also what src/ai/mcp/mcp-process.test.ts starts, with --port=0, to run the
 * agent and its tools in SEPARATE processes - as they are deployed.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { setRunbooks } from '../src/platform/runbook-loader.ts';
import { loadRunbooksFromDisk } from '../src/platform/runbook-loader.node.ts';
import { seedDemoWorld } from '../src/api/board-api.ts';
import { signDemoToken, verifyToken } from '../src/auth/cognito-jwt-verifier.ts';
import { recordToolCall } from '../src/ai/audit.ts';
import { serveMcp, MAX_MCP_BODY_CHARS } from '../src/ai/mcp/http.ts';
import { seedDemoData } from './seed-core.ts';

const arg = (name: string) => process.argv.find((a) => a.startsWith('--' + name + '='))?.split('=')[1];
const PORT = Number(arg('port') ?? process.env.MCP_PORT ?? 8000);
const HOST = process.env.MCP_HOST ?? '127.0.0.1';
const QUIET = process.argv.includes('--quiet');
const SEED = !process.argv.includes('--no-seed');

if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.error('mcp-local: refusing to bind ' + HOST + '. Its demo tokens are forgeable by anyone with this repo; loopback only.');
  process.exit(1);
}

setRunbooks(loadRunbooksFromDisk());
if (SEED) await seedDemoData();
// Pins the clock BEFORE the tokens are minted: they are stamped with it, and
// the verifier checks them against it. Minted on the wall clock they would be
// "issued in the future" by weeks. (After the seed, which moves the clock
// through eight weeks of baseline history.)
seedDemoWorld();

const PERSONAS = [
  { label: 'operator  acme-networks, Dallas only  ', claims: { sub: 'local-operator', email: 'operator@acme-networks.com', 'custom:tenantId': 'acme-networks', 'cognito:groups': ['operator'], 'custom:site': 'dal-01' } },
  { label: 'admin     acme-networks, tenant-wide  ', claims: { sub: 'local-admin', email: 'admin@acme-networks.com', 'custom:tenantId': 'acme-networks', 'cognito:groups': ['admin'] } },
  { label: 'admin     hhs-demo, + comms/ITSM tools', claims: { sub: 'local-hhs-admin', email: 'admin@hhs-demo.example', 'custom:tenantId': 'hhs-demo', 'cognito:groups': ['admin'] } },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = '';
    req.on('data', (chunk: Uint8Array) => {
      text += decoder.decode(chunk, { stream: true });
      // The server answers 413 past its own limit; this only stops a flood.
      if (text.length > MAX_MCP_BODY_CHARS * 2) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(text + decoder.decode()));
    req.on('error', reject);
  });
}

const log = (line: string) => { if (!QUIET) console.log(line); };

const server = createServer((req, res) => {
  if (req.url !== '/mcp' && !req.url?.startsWith('/mcp?')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'The MCP endpoint is /mcp.' }));
    return;
  }
  readBody(req)
    .then(async (body) => {
      let status = 0;
      await serveMcp({ method: req.method ?? 'GET', headers: flat(req), body }, {
        verify: async (token) => verifyToken(token),
        audit: async (principal, call) => {
          await recordToolCall(principal, call);
          log('    audit  ' + principal.tenantId + '/' + principal.sub + '  ' + call.tool + '  ' + call.outcome + '  ' + String(call.ms) + 'ms');
        },
      }, {
        writeHead: (s: number, h: Record<string, string>) => { status = s; return res.writeHead(s, h); },
        write: (chunk: string) => res.write(chunk),
        end: () => res.end(),
      });
      log((req.method ?? '?').padEnd(6) + String(status) + '  ' + rpcSummary(body));
    })
    .catch((err: unknown) => {
      console.error('mcp-local: ' + (err instanceof Error ? err.message : String(err)));
      if (!res.headersSent) { res.writeHead(400); res.end(); } else res.end();
    });
});

function flat(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/** "tools/call searchRunbooks" - for the log, from a body already answered. */
function rpcSummary(body: string): string {
  try {
    const m = JSON.parse(body) as { method?: string; params?: { name?: string } };
    return (m.method ?? '(response)') + (m.params?.name ? ' ' + m.params.name : '');
  } catch {
    return body ? '(not JSON)' : '';
  }
}

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  const url = 'http://' + (HOST === '::1' ? '[::1]' : HOST) + ':' + String(port) + '/mcp';
  // The first line is what the process test waits for. Keep its shape.
  console.log('MCP server: ' + url);
  if (QUIET) return;
  console.log('');
  console.log('Demo tokens (HS256, valid ONLY against this local server, never on AWS):');
  const tokens = PERSONAS.map((p) => ({ ...p, token: signDemoToken(p.claims) }));
  for (const p of tokens) console.log('  ' + p.label + '  ' + p.token);
  console.log('');
  console.log('Claude Code (as the Dallas operator):');
  console.log('  claude mcp add --transport http netpulse ' + url + ' --header "Authorization: Bearer ' + tokens[0].token + '"');
  console.log('MCP Inspector:  npx @modelcontextprotocol/inspector  ->  Streamable HTTP, ' + url + ', header Authorization: Bearer <token>');
  console.log('curl:');
  console.log("  curl -s " + url + " -H 'Authorization: Bearer <token>' -H 'Accept: application/json, text/event-stream' \\");
  console.log("    -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'");
  console.log('');
});
