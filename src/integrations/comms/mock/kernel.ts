/**
 * ---------------------------------------------------------------------------
 * The mock-vendor kernel: routing, auth, faults, cursors
 * ---------------------------------------------------------------------------
 * What the Teams, Genesys and Webex mocks share, which - as with the network
 * clouds in http.ts - is mechanics and never payload shape.
 *
 * PURE REQUEST -> RESPONSE, NO SERVER. A handler takes a plain object and
 * returns one, so the same mock answers three callers: the Node server in
 * `scripts/mock-vendors.ts` (for curl and Postman), `mockFetch` in index.ts
 * (a drop-in `fetch` for connectors and tests), and the board in the browser.
 * That last one is why nothing here may import `node:` - see CLAUDE.md.
 *
 * FAITHFUL WHERE IT BITES. The things a connector gets wrong against the real
 * service - an expired token, a 429 with Retry-After, a page cursor that must
 * be passed back verbatim, a page size over the vendor's maximum - behave the
 * way the vendor documents them. Anything the mock does NOT model answers 501
 * with a body that says so, rather than a plausible 404, so nobody mistakes a
 * gap in the mock for the vendor's behaviour.
 */
import { now } from '../../../platform/clock.ts';
import { b64urlEncode, b64urlDecodeText } from '../../../platform/crypto.ts';

export type ServiceId = 'teams' | 'genesys' | 'webex' | 'bandwidth' | 'helix';

export type MockRequest = {
  method: string;
  /** Path below the app's root, always starting with '/', percent-decoded. No query string. */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
  /**
   * The absolute URL this app was reached at, without a trailing slash.
   *
   * Next-page links are built from it, so a client that follows `nextUri` or
   * `@odata.nextLink` verbatim lands back on the mock whether it came through
   * the real hostname (mockFetch) or through localhost (the server).
   */
  base: string;
};

export type MockResponse = {
  status: number;
  headers?: Record<string, string>;
  /** JSON-serialised - unless `xml` is set, in which case this is sent as-is. */
  body?: unknown;
  /** The body is already XML text. Bandwidth's account API answers in XML. */
  xml?: boolean;
  /** The body is already text of this type - Helix's login returns a bare token. */
  contentType?: string;
};

type Params = Record<string, string>;
export type Handler = (req: MockRequest, params: Params) => MockResponse;

export type Route = {
  method: 'GET' | 'POST';
  /** `/api/v2/users/:userId`, or a RegExp with named groups for the odd ones. */
  pattern: string | RegExp;
  handler: Handler;
  /** Token endpoints are the only unauthenticated routes. */
  public?: boolean;
};

/** How this vendor spells an error. Each of the three spells it differently. */
export type ErrorShaper = (
  status: number, code: string, message: string, req: MockRequest,
) => MockResponse;

export type MockApp = {
  service: ServiceId;
  /** Which of the vendor's hosts this is, e.g. `graph` or `login`. */
  name: string;
  handle(req: MockRequest): MockResponse;
};

export function createApp(
  service: ServiceId, name: string, routes: Route[], error: ErrorShaper,
): MockApp {
  return {
    service,
    name,
    handle(req) {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const params = match(route.pattern, req.path);
        if (!params) continue;

        const fault = takeFault(service);
        if (fault) {
          const res = error(fault.status, faultCode(fault.status), 'injected fault', req);
          if (fault.status === 429) {
            res.headers = { ...res.headers, 'Retry-After': String(fault.retryAfterSeconds) };
          }
          return res;
        }

        if (!route.public) {
          const auth = service === 'bandwidth' ? checkBasic(req.headers)
            : service === 'helix' ? checkArJwt(req.headers)
              : checkBearer(service, req.headers);
          if (auth !== 'ok') {
            return error(401, 'unauthorized', 'credentials ' + auth, req);
          }
        }

        try {
          return route.handler(req, params);
        } catch (err) {
          if (err instanceof BadRequest) return error(400, 'bad.request', err.message, req);
          throw err;
        }
      }
      return notModelled(req);
    },
  };
}

function match(pattern: string | RegExp, path: string): Params | undefined {
  if (pattern instanceof RegExp) {
    const m = pattern.exec(path);
    return m ? { ...m.groups } : undefined;
  }
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return undefined;
  const params: Params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = got[i];   // already decoded by splitTarget
    else if (want[i] !== got[i]) return undefined;
  }
  return params;
}

/** Deliberately NOT vendor-shaped. A gap in the mock must look like one. */
export function notModelled(req: MockRequest): MockResponse {
  return {
    status: 501,
    body: {
      mock: true,
      message: 'Not modelled by the NetPulse mock: ' + req.method + ' ' + req.path +
        '. This is a gap in the mock, not the vendor\'s behaviour.',
    },
  };
}

/** Thrown by a handler for a malformed request; the app shapes it per vendor. */
export class BadRequest extends Error {}

export function jsonBody(req: MockRequest): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(req.body || '{}');
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new BadRequest('request body is not a JSON object');
}

export function intParam(
  req: MockRequest, name: string, fallback: number, min: number, max: number,
): number {
  const raw = req.query.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  // Out of range is an ERROR, not a clamp. The real services reject it, and a
  // mock that quietly clamped would hide a connector asking for pageSize=500.
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequest(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Bearer tokens, issued by the mock's own token endpoints and checked on every
 * other route.
 *
 * EXPIRY IS REAL, against the injected clock. That is what lets a test show
 * the Aruba lesson again on these services: a token that dies mid-drain gives
 * a 401 on a later page, and 401 is correctly not retried. Advance a fixed
 * clock past `expires_in` and the next call fails exactly as it would live.
 */
const tokens = new Map<string, { service: ServiceId; expiresAt: number }>();
let tokenCounter = 0;

export function issueToken(service: ServiceId, ttlSeconds: number): string {
  tokenCounter++;
  const token = 'mock-' + service + '-' + String(tokenCounter).padStart(6, '0');
  tokens.set(token, { service, expiresAt: now() + ttlSeconds * 1000 });
  return token;
}

/**
 * Webex has no client-credentials grant for most callers - a service app or
 * integration hands you a long-lived bearer token. The mock accepts any
 * `Bearer mock-webex-...` for Webex, and `DEMO_WEBEX_TOKEN` below is the one
 * the docs and tests use.
 */
export const DEMO_WEBEX_TOKEN = 'mock-webex-demo-only-not-a-real-token';

export function checkBearer(
  service: ServiceId, headers: Headers,
): 'ok' | 'missing' | 'invalid' | 'expired' {
  const header = headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) return 'missing';
  const token = m[1];
  if (service === 'webex' && token.startsWith('mock-webex-')) return 'ok';
  const t = tokens.get(token);
  if (!t || t.service !== service) return 'invalid';
  return now() < t.expiresAt ? 'ok' : 'expired';
}

/**
 * Helix (AR System): `Authorization: AR-JWT <token>`. Not "Bearer" - a client
 * that sends the token under the scheme every other API uses gets a 401 and
 * a token that looks perfectly valid.
 */
export function checkArJwt(headers: Headers): 'ok' | 'missing' | 'invalid' | 'expired' {
  const m = /^AR-JWT\s+(\S+)$/.exec(headers.get('authorization') ?? '');
  if (!m) return 'missing';
  const t = tokens.get(m[1]);
  if (!t || t.service !== 'helix') return 'invalid';
  return now() < t.expiresAt ? 'ok' : 'expired';
}

/** Helix: an integration user. Announces itself as fake. */
export const DEMO_HELIX_USER = {
  username: 'netpulse-integration',
  password: 'demo-only-not-a-real-password',
} as const;

/** Bandwidth: an API user, Basic auth on every request. Announces itself as fake. */
export const DEMO_BANDWIDTH_USER = {
  username: 'demo-api-user',
  password: 'demo-only-not-a-real-password',
} as const;

export function checkBasic(headers: Headers): 'ok' | 'missing' | 'invalid' {
  const m = /^Basic\s+(\S+)$/i.exec(headers.get('authorization') ?? '');
  if (!m) return 'missing';
  let pair = '';
  try { pair = atob(m[1]); } catch { return 'invalid'; }
  return pair === DEMO_BANDWIDTH_USER.username + ':' + DEMO_BANDWIDTH_USER.password ? 'ok' : 'invalid';
}

/**
 * Credentials the token endpoints accept. Announces itself as fake, for the
 * same reason the webhook secrets in controller/registry.ts do.
 */
export const DEMO_CLIENT = {
  clientId: 'demo-client-id',
  clientSecret: 'demo-only-not-a-real-secret',
} as const;

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

type Fault = { status: number; remaining: number; retryAfterSeconds: number };
const faults = new Map<ServiceId, Fault>();

/**
 * Make the next `times` calls to a service fail.
 *
 * An explicit switch rather than a failure rate, for the reason given on
 * `failNext` in controller/fixtures.ts: two runs must produce identical output.
 */
export function injectFault(
  service: ServiceId, status: 429 | 500 | 502 | 503, times = 1, retryAfterSeconds = 2,
): void {
  faults.set(service, { status, remaining: times, retryAfterSeconds });
}

function takeFault(service: ServiceId): Fault | undefined {
  const f = faults.get(service);
  if (!f) return undefined;
  if (--f.remaining <= 0) faults.delete(service);
  return f;
}

function faultCode(status: number): string {
  if (status === 429) return 'too.many.requests';
  if (status === 503) return 'service.unavailable';
  return 'internal.server.error';
}

/** Tests call this between cases. Tokens, faults, counters - all of it. */
export function resetMockState(): void {
  tokens.clear();
  faults.clear();
  tokenCounter = 0;
}

// ---------------------------------------------------------------------------
// Opaque cursors
// ---------------------------------------------------------------------------

/**
 * Graph's `$skiptoken` and Webex's `cursor` are opaque, and the mock keeps
 * them opaque on purpose: a connector that parsed one to rebuild the next URL
 * itself would pass against a readable `?offset=100` and break against the
 * real service. Base64url of the offset is enough to stop that habit forming.
 */
export function encodeCursor(offset: number): string {
  return b64urlEncode('o:' + String(offset));
}

export function decodeCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  let text: string;
  try { text = b64urlDecodeText(cursor); } catch { throw new BadRequest('invalid cursor'); }
  const m = /^o:(\d+)$/.exec(text);
  if (!m) throw new BadRequest('invalid cursor');
  return Number(m[1]);
}

/** The query string with some keys replaced; the rest carried over verbatim. */
export function withQuery(req: MockRequest, changes: Record<string, string>): string {
  const q = new URLSearchParams(req.query);
  for (const [k, v] of Object.entries(changes)) q.set(k, v);
  return req.base + req.path + '?' + q.toString();
}
