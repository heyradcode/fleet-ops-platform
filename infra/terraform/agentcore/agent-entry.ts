/**
 * The AgentCore Runtime entry point - what `node agent.js` runs in the microVM.
 *
 * AgentCore's HTTP contract, and nothing else: listen on 0.0.0.0:8080,
 * answer `GET /ping` with a status, and `POST /invocations` with the work.
 * Everything that matters is in src/ai/agent-invocation.ts; this file is the
 * socket and the wiring, the same split as the Lambda entries beside
 * infra/terraform/auth.
 *
 * NODE ONLY, and outside src/ for the usual reason: it imports `node:http`
 * and registers the two SDK adapters, none of which may reach the browser.
 * `pnpm build:agent` bundles it - SDKs included, since unlike Lambda the
 * NODE_22 AgentCore runtime ships no AWS SDK - into one CommonJS file.
 *
 * WIRING HAPPENS AT MODULE SCOPE, once per microVM. A session's microVM
 * serves every invocation in that session, so the DynamoDB client, the
 * Bedrock client and the pool's JWKS are set up once and reused.
 */
import { createServer, type IncomingMessage } from 'node:http';
import runbooks from 'netpulse:runbooks';
import { setRunbooks } from '../../../src/platform/runbook-loader.ts';
import { setTableStore } from '../../../src/aws/dynamodb.ts';
import { createSdkTableStore } from '../../../src/aws/dynamodb.sdk.ts';
import { setModelInvoker } from '../../../src/aws/bedrock.ts';
import { createClaudeInvoker } from '../../../src/aws/bedrock.sdk.ts';
import { verifyTokenRs256 } from '../../../src/auth/cognito-jwt-verifier.ts';
import { handleAgentInvocation } from '../../../src/ai/agent-invocation.ts';
import { env } from '../../../src/platform/env.ts';
import { log } from '../../../src/platform/logger.ts';

const table = env('TABLE_NAME', '');
const issuer = env('COGNITO_ISSUER', '');
const clientId = env('COGNITO_APP_CLIENT_ID', '');
const model = env('AGENT_MODEL', 'offline');
const fallbackModel = env('AGENT_FALLBACK_MODEL', '');

// The AWS SDKs read AWS_REGION. Terraform passes the region under its own
// name rather than setting a variable the runtime may consider its own.
const region = env('NETPULSE_REGION', '');
if (region && !process.env.AWS_REGION) process.env.AWS_REGION = region;

// Fail at START, not per request: a microVM that started without its table
// or its pool would answer every question with a 401 or a 500 that points at
// the token or the tools rather than at the missing variable.
const missing = Object.entries({ TABLE_NAME: table, COGNITO_ISSUER: issuer, COGNITO_APP_CLIENT_ID: clientId })
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) throw new Error('agent: missing ' + missing.join(', ') + ' - check the Terraform environment_variables');

setRunbooks(runbooks);
setTableStore(createSdkTableStore(table));
if (model !== 'offline') {
  setModelInvoker(createClaudeInvoker({ model, fallbackModel: fallbackModel || undefined }));
}
log.info('agent: wired', { model, fallbackModel: fallbackModel || '(none)', runbooks: runbooks.length });

/** Bounded, because an unauthenticated body is read before the handler runs. */
const MAX_BODY_BYTES = 64 * 1024;

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

const server = createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // Health. `Healthy`, never `HealthyBusy`: this agent runs no background
  // work, and a session reported busy is kept alive - and billed - until its
  // maximum lifetime instead of its idle timeout.
  if (req.method === 'GET' && req.url === '/ping') return send(200, { status: 'Healthy' });

  if (req.method === 'POST' && req.url?.startsWith('/invocations')) {
    readBody(req)
      .then((body) => handleAgentInvocation({ authorization: req.headers.authorization, body }, {
        verify: (token) => verifyTokenRs256(token, { issuer, clientId }),
        model,
      }))
      .then((out) => send(out.status, out.body))
      .catch((err: unknown) => {
        log.error('agent: request failed', { error: err instanceof Error ? err.message : String(err) });
        send(400, { error: 'Bad request.' });
      });
    return;
  }

  send(404, { error: 'Not found.' });
});

server.listen(8080, '0.0.0.0', () => log.info('agent: listening on 0.0.0.0:8080'));
