/**
 * ---------------------------------------------------------------------------
 * Mock Teams, Genesys and Webex APIs - the front door
 * ---------------------------------------------------------------------------
 * Two ways in, one set of handlers:
 *
 *   mockFetch   a drop-in `fetch`. Give it the REAL vendor URL -
 *               `https://graph.microsoft.com/v1.0/users` - and it answers
 *               from the mock. A connector written against it needs no
 *               change but the `fetch` it is handed to talk to the real
 *               service, which is the point: the mock sits at the transport,
 *               not in the connector.
 *
 *   MOCK_PREFIXES  the same apps under path prefixes, for the Node server in
 *               `scripts/mock-vendors.ts`, so curl and Postman can reach them
 *               on one localhost port.
 *
 * Portable: `Request`, `Response`, `Headers` and `URL` are globals in Node 22
 * and in every browser, so the board can use `mockFetch` in the tab.
 */
import type { MockApp, MockRequest, MockResponse } from './kernel.ts';
import { notModelled, resetMockState as resetKernelState } from './kernel.ts';
import { resetEntraChanges, teamsGraph, teamsLogin } from './teams.ts';
import { plantedActive, setPlanted } from './time.ts';
import { fixedClock, getClock, setClock } from '../../../platform/clock.ts';
import { genesysApi, genesysLogin } from './genesys.ts';
import { webexAnalytics, webexApi, webexCallingAnalytics } from './webex.ts';
import { bandwidthApi, bandwidthInsights } from './bandwidth.ts';
import { helixApi } from './helix.ts';
import { kurmiApi, resetKurmi } from './kurmi.ts';
import { resetStarlink, starlinkApi, starlinkAuth } from './starlink.ts';

export {
  clearFaults, DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_WEBEX_TOKEN, injectFault, type ServiceId,
} from './kernel.ts';
export { HELIX_PLANTED } from './helix.ts';
export { DEMO_KURMI_USER, KURMI_TENANT_DBID, kurmiPhones, setKurmiMaxResults } from './kurmi.ts';
export { DEMO_STARLINK_ACCOUNTS, STARLINK_RETENTION_MS, STARLINK_TERMINALS } from './starlink.ts';
export { BANDWIDTH_ACCOUNT, BANDWIDTH_PEERS, BANDWIDTH_PLANTED } from './bandwidth.ts';
export { mutateEntraUser, removeEntraUser, DELTA_TOKEN_TTL_MS } from './teams.ts';
export { setPlanted } from './time.ts';

/**
 * Test harness for anomaly backfill: read signals "as at" a past time.
 *
 * The mocks only serve activity near the injected clock, so this moves the
 * clock to the past time, turns the planted problems OFF (history is meant to
 * be normal), reads, and puts both back - whatever they were. Production never
 * needs this: the vendors answer for past windows directly.
 */
export function mockHistory<T>(read: (at: number) => Promise<T>): (at: number) => Promise<T> {
  return async (past: number) => {
    const clock = getClock();
    const wasPlanted = plantedActive();
    setClock(fixedClock(past));
    setPlanted(false);
    try {
      return await read(past);
    } finally {
      setPlanted(wasPlanted);
      setClock(clock);
    }
  };
}

/** Tests call this between cases: tokens, faults, and Entra directory changes. */
export function resetMockState(): void {
  resetKernelState();
  resetEntraChanges();
  setPlanted(true);
  resetKurmi();
  resetStarlink();
}
export { directory, agencyOf, facilityCodeOf, AGENCY_DOMAINS, FACILITIES } from './directory.ts';
export { PLANTED as TEAMS_PLANTED, TEAMS_TRUNKS } from './teams.ts';
export { PLANTED_QUEUE as GENESYS_PLANTED_QUEUE, SUBTLE_QUEUE as GENESYS_SUBTLE_QUEUE, genesysQueues } from './genesys.ts';
export { CDR_VISIBILITY_DELAY_MS } from './webex.ts';

/** Real hostname -> the app that stands in for it. */
export const MOCK_HOSTS: Record<string, MockApp> = {
  'login.microsoftonline.com': teamsLogin,
  'graph.microsoft.com': teamsGraph,
  'login.use2.us-gov-pure.cloud': genesysLogin,
  'api.use2.us-gov-pure.cloud': genesysApi,
  'webexapis.com': webexApi,
  'analytics.webexapis.com': webexAnalytics,
  'analytics-calling.webexapis.com': webexCallingAnalytics,
  'api.bandwidth.com': bandwidthApi,
  'insights.bandwidth.com': bandwidthInsights,
  'hhs-restapi.onbmc.example': helixApi,
  'kurmi.hhs.example': kurmiApi,
  'www.starlink.com': starlinkAuth,
  'starlink.com': starlinkApi,
};

/** Localhost path prefix -> app, for the Node server. */
export const MOCK_PREFIXES: Record<string, MockApp> = {
  '/msft-login': teamsLogin,
  '/graph': teamsGraph,
  '/genesys-login': genesysLogin,
  '/genesys': genesysApi,
  '/webex': webexApi,
  '/webex-analytics': webexAnalytics,
  '/webex-calling': webexCallingAnalytics,
  '/bandwidth': bandwidthApi,
  '/bandwidth-insights': bandwidthInsights,
  '/helix': helixApi,
  '/kurmi': kurmiApi,
  '/starlink-auth': starlinkAuth,
  '/starlink': starlinkApi,
};

/**
 * Split a raw request target into path and query WITHOUT normalising the path.
 *
 * `new URL()` would do, except for Graph's function-call segments -
 * `getDirectRoutingCalls(fromDateTime=...,toDateTime=...)` - where a client
 * may or may not percent-encode the colons, and the route has to see the same
 * text either way.
 */
export function splitTarget(target: string): { path: string; query: URLSearchParams } {
  const q = target.indexOf('?');
  const rawPath = q === -1 ? target : target.slice(0, q);
  // Per segment, so an encoded ',' or ':' is decoded but an encoded '/'
  // cannot split a segment in two.
  const path = rawPath.split('/').map((seg) => {
    try { return decodeURIComponent(seg); } catch { return seg; }
  }).join('/');
  return { path: path || '/', query: new URLSearchParams(q === -1 ? '' : target.slice(q + 1)) };
}

/** Run one request through an app and turn the result into a `Response`. */
export function toResponse(res: MockResponse): Response {
  const headers = new Headers(res.headers);
  if (res.body === undefined) return new Response(null, { status: res.status, headers });
  if (res.xml || res.contentType) {
    headers.set('Content-Type', res.contentType ?? 'application/xml');
    return new Response(String(res.body), { status: res.status, headers });
  }
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(res.body), { status: res.status, headers });
}

/** A `fetch` that answers the seven vendor hosts above from the mocks. */
export async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const app = MOCK_HOSTS[url.host];
  const target = request.url.slice(url.origin.length);
  const { path, query } = splitTarget(target);
  const req: MockRequest = {
    method: request.method,
    path,
    query,
    headers: request.headers,
    body: request.method === 'GET' ? '' : await request.text(),
    base: url.origin,
  };
  // An unknown host is a connector pointed somewhere the mock does not
  // cover. Answer 501, never fall through to the network.
  return toResponse(app ? app.handle(req) : notModelled(req));
}
