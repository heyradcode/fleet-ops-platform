/**
 * The Teams / Genesys / Webex mocks on localhost, for curl and Postman.
 *
 *   pnpm mock                      # http://127.0.0.1:5190
 *   MOCK_PORT=6000 pnpm mock
 *
 * LIVES IN scripts/, NOT src/, because it imports `node:http` - and nothing in
 * src/ may, or the board's browser build breaks (see CLAUDE.md). The handlers
 * it serves are the portable ones in src/integrations/comms/mock/; this file
 * is only the socket.
 *
 * BINDS 127.0.0.1 BY DEFAULT, unlike the Vite dev server. There is nothing
 * secret here, but a mock that answers `/oauth/token` with a valid-looking
 * token on the LAN is an odd thing to leave lying around. MOCK_HOST=0.0.0.0
 * if you really need it from another machine.
 *
 * Runs on the REAL clock, so activity follows the wall clock - unlike the
 * demo and the tests, which pin it. See comms/mock/time.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_WEBEX_TOKEN, directory, injectFault, MOCK_PREFIXES, resetMockState,
  splitTarget, type ServiceId,
} from '../src/integrations/comms/mock/index.ts';
import type { MockRequest, MockResponse } from '../src/integrations/comms/mock/kernel.ts';

const PORT = Number(process.env.MOCK_PORT ?? 5190);
const HOST = process.env.MOCK_HOST ?? '127.0.0.1';
const ORIGIN = 'http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + String(PORT);

async function readBody(req: IncomingMessage): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of req) text += decoder.decode(chunk as Uint8Array, { stream: true });
  return text + decoder.decode();
}

function send(res: ServerResponse, out: MockResponse): void {
  const headers: Record<string, string> = { ...out.headers };
  const raw = out.xml || out.contentType;
  if (out.body !== undefined) headers['Content-Type'] = out.contentType ?? (out.xml ? 'application/xml' : 'application/json');
  res.writeHead(out.status, headers);
  res.end(out.body === undefined ? undefined : raw ? String(out.body) : JSON.stringify(out.body, null, 2));
}

/** `/__mock/...`: test controls that no vendor has. */
function control(path: string, query: URLSearchParams): MockResponse | undefined {
  if (path === '/__mock/reset') {
    resetMockState();
    return { status: 200, body: { reset: true } };
  }
  if (path === '/__mock/fault') {
    const service = query.get('service') as ServiceId | null;
    const status = Number(query.get('status') ?? 429) as 429 | 500 | 502 | 503;
    if (!service || !['teams', 'genesys', 'webex', 'bandwidth', 'helix'].includes(service)) {
      return { status: 400, body: { message: 'service must be teams, genesys, webex, bandwidth or helix' } };
    }
    injectFault(service, status, Number(query.get('times') ?? 1), Number(query.get('retryAfter') ?? 2));
    return { status: 200, body: { injected: { service, status } } };
  }
  return undefined;
}

const server = createServer(async (req, res) => {
  const { path, query } = splitTarget(req.url ?? '/');
  const method = req.method ?? 'GET';

  let out: MockResponse | undefined;
  if (method === 'POST' && path.startsWith('/__mock/')) out = control(path, query);

  if (!out) {
    const prefix = Object.keys(MOCK_PREFIXES).find((p) => path === p || path.startsWith(p + '/'));
    if (!prefix) {
      out = { status: 404, body: { mock: true, message: 'no mock under ' + path + '; try GET /' } };
      if (path === '/') out = { status: 200, body: catalogue() };
    } else {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const mockReq: MockRequest = {
        method,
        path: path.slice(prefix.length) || '/',
        query,
        headers,
        body: method === 'GET' ? '' : await readBody(req),
        base: ORIGIN + prefix,
      };
      out = MOCK_PREFIXES[prefix].handle(mockReq);
    }
  }

  send(res, out);
  console.log(method.padEnd(4), String(out.status), req.url);
});

function catalogue() {
  const d = directory();
  return {
    note: 'Synthetic data modelled from published API references. Not captured from any live tenant.',
    credentials: {
      clientId: DEMO_CLIENT.clientId,
      clientSecret: DEMO_CLIENT.clientSecret,
      entraTenantId: d.entraTenantId,
      webexToken: DEMO_WEBEX_TOKEN,
    },
    teams: [
      'POST ' + ORIGIN + '/msft-login/' + d.entraTenantId + '/oauth2/v2.0/token',
      'GET  ' + ORIGIN + '/graph/v1.0/users?$select=id,userPrincipalName,department,streetAddress',
      'GET  ' + ORIGIN + '/graph/v1.0/users/delta?$select=id,userPrincipalName,streetAddress   (Prefer: odata.maxpagesize=N)',
      'GET  ' + ORIGIN + '/graph/v1.0/admin/teams/userConfigurations?$filter=isEnterpriseVoiceEnabled eq true',
      'GET  ' + ORIGIN + '/graph/v1.0/communications/callRecords?$filter=startDateTime ge <iso>',
      'GET  ' + ORIGIN + '/graph/v1.0/communications/callRecords/{id}?$expand=sessions($expand=segments)',
      'GET  ' + ORIGIN + '/graph/v1.0/communications/callRecords/getDirectRoutingCalls(fromDateTime=<iso>,toDateTime=<iso>)',
    ],
    genesys: [
      'POST ' + ORIGIN + '/genesys-login/oauth/token   (Basic client_id:client_secret)',
      'GET  ' + ORIGIN + '/genesys/api/v2/users?pageSize=100&pageNumber=1',
      'GET  ' + ORIGIN + '/genesys/api/v2/authorization/divisions',
      'GET  ' + ORIGIN + '/genesys/api/v2/routing/queues',
      'GET  ' + ORIGIN + '/genesys/api/v2/routing/queues/{queueId}/members',
      'POST ' + ORIGIN + '/genesys/api/v2/analytics/queues/observations/query',
      'POST ' + ORIGIN + '/genesys/api/v2/analytics/conversations/aggregates/query',
    ],
    webex: [
      'GET  ' + ORIGIN + '/webex/v1/people?callingData=true',
      'GET  ' + ORIGIN + '/webex/v1/locations',
      'GET  ' + ORIGIN + '/webex/v1/meetings?meetingType=meeting',
      'GET  ' + ORIGIN + '/webex-analytics/v1/meeting/qualities?meetingId={instanceId}',
      'GET  ' + ORIGIN + '/webex-calling/v1/cdr_feed?startTime=<iso>&endTime=<iso>',
    ],
    bandwidth: [
      'GET  ' + ORIGIN + '/bandwidth/api/accounts/9900001/sites   (Basic ' + DEMO_BANDWIDTH_USER.username + ':...)',
      'GET  ' + ORIGIN + '/bandwidth/api/accounts/9900001/sites/{siteId}/sippeers',
      'GET  ' + ORIGIN + '/bandwidth-insights/api/v1/accounts/9900001/voice/summary?startTime=<iso>&endTime=<iso>&groupBy=location   (PLACEHOLDER shape)',
    ],
    helix: [
      'POST ' + ORIGIN + '/helix/api/jwt/login   (form: username, password -> text token)',
      "GET  " + ORIGIN + "/helix/api/arsys/v1/entry/CHG:Infrastructure Change?q='Actual Start Date' >= \"<iso>\"&fields=values(...)   (Authorization: AR-JWT <token>)",
      "GET  " + ORIGIN + "/helix/api/arsys/v1/entry/HPD:Help Desk?q='Status' != \"Closed\"&fields=values(...)",
    ],
    controls: [
      'POST ' + ORIGIN + '/__mock/fault?service=genesys&status=429&times=2',
      'POST ' + ORIGIN + '/__mock/reset',
    ],
  };
}

server.listen(PORT, HOST, () => {
  console.log('Mock Teams / Genesys / Webex on ' + ORIGIN + '  -  GET / for the catalogue');
});
