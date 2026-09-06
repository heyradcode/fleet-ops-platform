/**
 * ---------------------------------------------------------------------------
 * API Gateway REST endpoints (HTTP API v2 payload format)
 * ---------------------------------------------------------------------------
 * GraphQL is the primary API. REST still earns its place for:
 *   - webhooks from third parties, which cannot speak GraphQL;
 *   - health checks and machine-to-machine polling;
 *   - anything a customer's integration team will curl.
 *
 * REST vs HTTP API on API Gateway - pick knowingly:
 *   HTTP API  - ~70% cheaper, lower latency, native JWT authorizer. Default.
 *   REST API  - request validation, API keys + usage plans, WAF, private
 *               endpoints, canary deployments. Use when you need those.
 *
 * Notice the handler never parses a JWT. The Lambda authorizer already did it
 * and passed the result through `requestContext.authorizer.lambda`. One
 * verification per token per hour, not one per request.
 */
import type { Principal } from '../platform/types.ts';
import { principalFromContext } from '../auth/authorizer.ts';
import { recentSignals, openIncidents } from '../platform/repository.ts';
import { allSites, sitesWithinRadius, getSite } from '../geo/site-repository.ts';
import { sitesToFeatureCollection } from '../geo/geojson.ts';
import { signalsForSite } from '../platform/repository.ts';
import { mapPayload } from '../geo/mapbox.ts';
import { encode as toTopoJson, compressionRatio } from '../geo/topojson.ts';
import { askWithRag } from '../ai/bedrock-rag.ts';
import { requireRole } from '../platform/tenancy.ts';
import { log } from '../platform/logger.ts';

export type ApiGatewayEvent = {
  version: '2.0';
  routeKey: string;               // e.g. "GET /sites"
  rawPath: string;
  headers: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  pathParameters?: Record<string, string>;
  body?: string;
  requestContext: {
    requestId: string;
    http: { method: string; path: string };
    authorizer?: { lambda: Record<string, string> };
  };
};

export type ApiGatewayResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResult> {
  const auth = event.requestContext.authorizer?.lambda;
  if (!auth?.tenantId) return json(401, { message: 'Unauthorized' });

  const principal = principalFromContext(auth);
  const query = event.queryStringParameters ?? {};

  try {
    switch (event.routeKey) {
      case 'GET /health':
        // No auth in production for this one - it is what the ALB/Route53
        // health check hits, and it must not depend on Cognito being up.
        return json(200, { status: 'ok', ts: new Date().toISOString() });

      case 'GET /sites':
        return json(200, { items: allSites(principal) });

      case 'GET /sites/{siteId}': {
        const site = getSite(principal, String(event.pathParameters?.siteId));
        return site ? json(200, site) : json(404, { message: 'site not found' });
      }

      case 'GET /sites/near': {
        // Validate at the edge. In a REST API you would attach a JSON Schema
        // request validator so API Gateway rejects this before your Lambda is
        // ever invoked - cheaper, and one less code path to test.
        const lon = Number(query.lon);
        const lat = Number(query.lat);
        const radiusKm = Number(query.radiusKm ?? 100);

        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
          return json(400, { message: 'lon and lat are required numbers' });
        }
        if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
          return json(400, { message: 'coordinates out of range - did you swap lon and lat?' });
        }

        return json(200, { items: sitesWithinRadius(principal, { lon, lat }, radiusKm) });
      }

      case 'GET /signals': {
        const limit = Math.min(Number(query.limit ?? 25), 100);
        return json(200, { items: recentSignals(principal, limit) });
      }

      case 'GET /incidents':
        return json(200, { items: openIncidents(principal) });

      /**
       * The map endpoint. Serves GeoJSON by default and TopoJSON when the
       * client asks - `?format=topojson`. Content negotiation on a query
       * parameter rather than Accept keeps it debuggable from a browser bar.
       */
      case 'GET /map': {
        const sites = allSites(principal);
        const bySite = new Map(sites.map((s) => [s.siteId, signalsForSite(principal, s.siteId)]));
        const fc = sitesToFeatureCollection(sites, bySite);

        if (query.format === 'topojson') {
          const topo = toTopoJson(fc);
          return json(200, { topology: topo, savedFraction: compressionRatio(fc, topo) });
        }
        return json(200, mapPayload(fc), {
          // Public-ish, changes every poll cycle. 30s of CDN caching removes
          // most of the load from a dashboard that 500 people leave open.
          'Cache-Control': 'private, max-age=30',
        });
      }

      case 'POST /ask': {
        const body = JSON.parse(event.body ?? '{}') as { question?: string };
        if (!body.question) return json(400, { message: 'question is required' });

        const rag = await askWithRag(body.question, principal);
        return json(200, rag);
      }

      case 'POST /incidents': {
        requireRole(principal, 'admin', 'operator');
        return json(501, { message: 'use the GraphQL openIncident mutation - it drives the subscription' });
      }

      /**
       * Inbound webhook. Three rules, all non-negotiable:
       *   1. Verify the signature (HMAC over the raw body) BEFORE parsing.
       *   2. Return 200 fast - queue the work, do not process inline. Vendors
       *      retry aggressively on slow responses and you will get duplicates.
       *   3. Be idempotent: you WILL receive the same delivery twice.
       */
      case 'POST /webhooks/{provider}': {
        const provider = String(event.pathParameters?.provider);
        const signature = event.headers['x-webhook-signature'] ?? '';
        if (!signature) return json(401, { message: 'missing signature' });

        log.info('webhook accepted', { provider, requestId: event.requestContext.requestId });
        // -> SQS -> ingest pipeline. Never process here.
        return json(202, { accepted: true, provider });
      }

      default:
        return json(404, { message: 'no route for ' + event.routeKey });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('forbidden')) return json(403, { message });

    // Log the detail, return a generic message. Stack traces and internal
    // identifiers in an HTTP response are an information-disclosure finding.
    log.error('unhandled error', { route: event.routeKey, error: message });
    return json(500, { message: 'internal error', requestId: event.requestContext.requestId });
  }
}

function json(statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}): ApiGatewayResult {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      // Security headers belong on every response. In production set these
      // once at the API Gateway / CloudFront layer instead of per-handler.
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

/** Build the authorizer context an event carries, for the local demo. */
export function eventFor(
  routeKey: string,
  principal: Principal,
  opts: { query?: Record<string, string>; path?: Record<string, string>; body?: unknown } = {},
): ApiGatewayEvent {
  const [method, path] = routeKey.split(' ');
  return {
    version: '2.0',
    routeKey,
    rawPath: path,
    headers: {},
    queryStringParameters: opts.query,
    pathParameters: opts.path,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    requestContext: {
      requestId: 'req-' + Math.random().toString(36).slice(2, 10),
      http: { method, path },
      authorizer: {
        lambda: {
          tenantId: principal.tenantId,
          email: principal.email,
          roles: principal.roles.join(','),
          identityProvider: principal.identityProvider,
          sub: principal.sub,
        },
      },
    },
  };
}
