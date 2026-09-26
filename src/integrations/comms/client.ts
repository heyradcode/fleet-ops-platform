/**
 * ---------------------------------------------------------------------------
 * The comms HTTP client: tokens, retries, and three paging dialects
 * ---------------------------------------------------------------------------
 * The same mechanics http.ts names for the network clouds, met again on three
 * new services, each spelled differently:
 *
 *   auth       Entra: client credentials in the FORM body, `.default` scope.
 *              Genesys: client credentials in a BASIC header.
 *              Webex: a long-lived bearer token from a service app.
 *   paging     Graph: an opaque `@odata.nextLink` in the body.
 *              Genesys: one-indexed `pageNumber`, `pageCount` in the body.
 *              Webex: a `Link` HEADER; the body says nothing.
 *
 * `fetch` IS INJECTED. Offline it is `mockFetch`, which answers the real
 * hostnames; in a Lambda it is the global. Nothing else changes, so what the
 * tests exercise is the code that runs.
 *
 * TOKENS REFRESH EARLY, the Aruba Central lesson from CLAUDE.md applied again:
 * a token that dies on page four of seven gives a 401, 401 is correctly not
 * retried, and the run ends with a partial workforce and no obvious cause.
 * Sixty seconds of headroom removes the class. The cache is per TENANT - a
 * shared one would hand one customer's Graph token to another's poll.
 */
import { now } from '../../platform/clock.ts';
import { random } from '../../platform/random.ts';
import { b64urlEncode } from '../../platform/crypto.ts';
import { drainPages, type HttpPage, type PageCursor } from '../http.ts';
import { log } from '../../platform/logger.ts';
import type { TenantId } from '../../platform/types.ts';
import type { CommsSource } from './types.ts';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Base URLs. The defaults are the real hosts; override to point at `pnpm mock`. */
export type CommsEndpoints = {
  entraLogin: string;
  graph: string;
  genesysLogin: string;
  genesysApi: string;
  webexApi: string;
  /** Meeting qualities live on their own host. */
  webexAnalytics: string;
};

export const REAL_ENDPOINTS: CommsEndpoints = {
  entraLogin: 'https://login.microsoftonline.com',
  graph: 'https://graph.microsoft.com/v1.0',
  genesysLogin: 'https://login.use2.us-gov-pure.cloud',
  genesysApi: 'https://api.use2.us-gov-pure.cloud',
  webexApi: 'https://webexapis.com/v1',
  webexAnalytics: 'https://analytics.webexapis.com/v1',
};

/** In production these come from Secrets Manager, per tenant, cached across warm starts. */
export type CommsCredentials = {
  entra?: { tenantId: string; clientId: string; clientSecret: string };
  genesys?: { clientId: string; clientSecret: string };
  webex?: { token: string };
};

export class CommsHttpError extends Error {
  readonly source: CommsSource;
  readonly status: number;
  /** 429 and 5xx are worth retrying; 400, 401 and 403 never are. See ProviderError. */
  readonly retryable: boolean;

  constructor(source: CommsSource, status: number, message: string) {
    super('[' + source + '] ' + status + ' ' + message);
    this.name = 'CommsHttpError';
    this.source = source;
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

/** Refresh this long before a token's stated expiry. */
export const TOKEN_HEADROOM_MS = 60_000;
/** A Retry-After longer than this fails the run instead of parking a Lambda. */
export const MAX_RETRY_AFTER_MS = 30_000;
const ATTEMPTS = 3;

type CachedToken = { token: string; expiresAt: number };

export type CommsClient = {
  tenantId: TenantId;
  endpoints: CommsEndpoints;
  /** GET or POST with auth and retries. Throws CommsHttpError on a final failure. */
  request(source: CommsSource, url: string, init?: RequestInit): Promise<Response>;
  /** How many token requests have been made, per source. For the tests and the demo. */
  tokenRequests: Record<CommsSource, number>;
};

export function createCommsClient(opts: {
  tenantId: TenantId;
  fetch: FetchFn;
  credentials: CommsCredentials;
  endpoints?: CommsEndpoints;
  /** Injected so tests and the demo do not really wait out a Retry-After. */
  sleep?: (ms: number) => Promise<void>;
}): CommsClient {
  const endpoints = opts.endpoints ?? REAL_ENDPOINTS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cache = new Map<CommsSource, CachedToken>();
  const tokenRequests: Record<CommsSource, number> = { teams: 0, genesys: 0, webex: 0 };

  async function fetchToken(source: CommsSource): Promise<CachedToken> {
    tokenRequests[source]++;
    let res: Response;
    if (source === 'teams') {
      const c = opts.credentials.entra;
      if (!c) throw new CommsHttpError(source, 0, 'no Entra credentials configured');
      res = await opts.fetch(endpoints.entraLogin + '/' + c.tenantId + '/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: c.clientId,
          client_secret: c.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }).toString(),
      });
    } else if (source === 'genesys') {
      const c = opts.credentials.genesys;
      if (!c) throw new CommsHttpError(source, 0, 'no Genesys credentials configured');
      res = await opts.fetch(endpoints.genesysLogin + '/oauth/token', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + basic(c.clientId + ':' + c.clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
    } else {
      const c = opts.credentials.webex;
      if (!c) throw new CommsHttpError(source, 0, 'no Webex token configured');
      // Long-lived; its rotation is an operational task, not a runtime one.
      return { token: c.token, expiresAt: Infinity };
    }
    if (!res.ok) throw new CommsHttpError(source, res.status, 'token request failed: ' + await res.text());
    const body = await res.json() as { access_token: string; expires_in: number };
    return { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
  }

  async function tokenFor(source: CommsSource): Promise<string> {
    const cached = cache.get(source);
    if (cached && now() < cached.expiresAt - TOKEN_HEADROOM_MS) return cached.token;
    const fresh = await fetchToken(source);
    cache.set(source, fresh);
    return fresh.token;
  }

  async function request(source: CommsSource, url: string, init: RequestInit = {}): Promise<Response> {
    let last: CommsHttpError | undefined;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', 'Bearer ' + await tokenFor(source));
      headers.set('Accept', 'application/json');
      const res = await opts.fetch(url, { ...init, headers });
      if (res.ok) return res;

      last = new CommsHttpError(source, res.status, await res.text());
      if (!last.retryable || attempt === ATTEMPTS) break;

      // Retry-After, when the service sends one, is an instruction rather
      // than a hint - retrying sooner is how an integration gets its quota
      // cut. Without one, full-jitter backoff as in connector.ts.
      const retryAfter = Number(res.headers.get('Retry-After'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : random() * 200 * Math.pow(2, attempt - 1);
      if (wait > MAX_RETRY_AFTER_MS) break;
      log.warn(source + ' ' + res.status + ', retrying', { attempt, waitMs: Math.round(wait) });
      await sleep(wait);
    }
    throw last!;
  }

  return { tenantId: opts.tenantId, endpoints, request, tokenRequests };
}

/** Standard base64 for a Basic header, built on the portable encoder. */
function basic(text: string): string {
  const url = b64urlEncode(text).replace(/-/g, '+').replace(/_/g, '/');
  return url + '='.repeat((4 - (url.length % 4)) % 4);
}

// ---------------------------------------------------------------------------
// The three paging dialects, each on top of drainPages
// ---------------------------------------------------------------------------

export type Drained<T> = { rows: T[]; pages: number; truncated: boolean };

function drained<T>(r: { records: unknown[]; pages: number; truncated: boolean }): Drained<T> {
  return { rows: r.records as T[], pages: r.pages, truncated: r.truncated };
}

/** Graph: follow `@odata.nextLink` verbatim. It carries an opaque `$skiptoken`. */
export async function drainGraph<T>(client: CommsClient, url: string): Promise<Drained<T>> {
  return drained(await drainPages(async (cursor: PageCursor): Promise<HttpPage> => {
    if (cursor.kind !== 'link-header') throw new Error('graph cursor must be a link');
    const body = await (await client.request('teams', cursor.next)).json() as {
      value: unknown[]; '@odata.nextLink'?: string;
    };
    const next = body['@odata.nextLink'];
    return { records: body.value, next: next ? { kind: 'link-header', next } : { kind: 'done' } };
  }, { kind: 'link-header', next: url }));
}

/**
 * Genesys: one-indexed pages, stopping on `pageCount`.
 *
 * NOT by following `nextUri`: it is relative, and joining it to the ORIGIN
 * rather than the configured API base is exactly the bug that works against
 * the real host and fails behind any path prefix. Counting pages from the
 * envelope avoids the join altogether.
 */
export async function drainGenesys<T>(
  client: CommsClient, path: string, query: Record<string, string> = {},
): Promise<Drained<T>> {
  const PAGE_SIZE = 100;   // the documented maximum
  return drained(await drainPages(async (cursor: PageCursor): Promise<HttpPage> => {
    if (cursor.kind !== 'page') throw new Error('genesys cursor must be a page');
    const q = new URLSearchParams({ ...query, pageSize: String(cursor.limit), pageNumber: String(cursor.page) });
    const body = await (await client.request('genesys', client.endpoints.genesysApi + path + '?' + q)).json() as {
      entities: unknown[]; pageNumber: number; pageCount: number;
    };
    return {
      records: body.entities,
      next: body.pageNumber < body.pageCount
        ? { kind: 'page', page: cursor.page + 1, limit: cursor.limit }
        : { kind: 'done' },
    };
  }, { kind: 'page', page: 1, limit: PAGE_SIZE }));
}

/** Webex: the next page is in the `Link` header and nowhere else. */
export async function drainWebex<T>(client: CommsClient, url: string): Promise<Drained<T>> {
  return drained(await drainPages(async (cursor: PageCursor): Promise<HttpPage> => {
    if (cursor.kind !== 'link-header') throw new Error('webex cursor must be a link');
    const res = await client.request('webex', cursor.next);
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('Link') ?? '')?.[1];
    const body = await res.json() as { items: unknown[] };
    return { records: body.items, next: next ? { kind: 'link-header', next } : { kind: 'done' } };
  }, { kind: 'link-header', next: url }));
}
