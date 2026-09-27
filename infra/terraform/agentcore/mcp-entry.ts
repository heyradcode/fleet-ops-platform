/**
 * The MCP server's AgentCore Runtime entry point - what `node mcp.js` runs.
 *
 * AgentCore's MCP contract: listen on 0.0.0.0:8000 and answer `POST /mcp`
 * as stateless streamable HTTP. The platform assigns `Mcp-Session-Id` and
 * routes on it; the server accepts it and keeps nothing under it. Everything
 * that can be wrong is in src/ai/mcp/http.ts and tested; this file is the
 * socket and the wiring, as agent-entry.ts is for the agent.
 *
 * The tools compute exactly as the agent's would in-process: the same
 * `runTool`, the same seeded world, the runbooks embedded the same way. What
 * this runtime adds is a place that is NOT the agent - its own role, its own
 * logs, and the audit trail it writes for every call.
 */
import { createServer, type IncomingMessage } from 'node:http';
import runbooks from 'netpulse:runbooks';
import { setRunbooks } from '../../../src/platform/runbook-loader.ts';
import { setTableStore } from '../../../src/aws/dynamodb.ts';
import { createSdkTableStore } from '../../../src/aws/dynamodb.sdk.ts';
import { verifyTokenRs256 } from '../../../src/auth/cognito-jwt-verifier.ts';
import { serveMcp, MAX_MCP_BODY_CHARS } from '../../../src/ai/mcp/http.ts';
import { env } from '../../../src/platform/env.ts';
import { log } from '../../../src/platform/logger.ts';

const table = env('TABLE_NAME', '');
const issuer = env('COGNITO_ISSUER', '');
const clientId = env('COGNITO_APP_CLIENT_ID', '');

const region = env('NETPULSE_REGION', '');
if (region && !process.env.AWS_REGION) process.env.AWS_REGION = region;

// Fail at START - the agent-entry.ts rule.
const missing = Object.entries({ TABLE_NAME: table, COGNITO_ISSUER: issuer, COGNITO_APP_CLIENT_ID: clientId })
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) throw new Error('mcp: missing ' + missing.join(', ') + ' - check the Terraform environment_variables');

setRunbooks(runbooks);
setTableStore(createSdkTableStore(table));
log.info('mcp: wired', { runbooks: runbooks.length });

/** Bounded: the body is read before the token is checked. A byte past the parser's limit is a 413 there. */
const MAX_BODY_BYTES = MAX_MCP_BODY_CHARS * 4 + 1;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Node's headers, flattened to the one-string-per-name shape serveMcp reads. */
function flat(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

const server = createServer((req, res) => {
  // Health, as for the agent: `Healthy`, never `HealthyBusy`.
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Healthy' }));
    return;
  }

  if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
    readBody(req)
      .then((body) => serveMcp({ method: req.method ?? 'GET', headers: flat(req), body }, {
        verify: (token) => verifyTokenRs256(token, { issuer, clientId }),
      }, res))
      .catch((err: unknown) => {
        log.error('mcp: request failed', { error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Bad request.' } }));
        } else {
          res.end();
        }
      });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found.' }));
});

server.listen(8000, '0.0.0.0', () => log.info('mcp: listening on 0.0.0.0:8000/mcp'));
