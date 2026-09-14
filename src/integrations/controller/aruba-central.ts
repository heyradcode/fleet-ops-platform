/**
 * HPE Aruba Central API.
 *
 * Auth:  OAuth2 client credentials -> a bearer token with a ~2h lifetime. So
 *        unlike the other two this connector has a REFRESH to get wrong, and
 *        getting it wrong is a 401 storm halfway through a poll rather than a
 *        clean failure at the start. `ensureToken` below is the whole story.
 * Rate:  ~7 requests/second per customer; 429 with Retry-After.
 * Paging: `offset` and `limit`. The total comes back as `total`, and the last
 *        page is the one that returns fewer rows than `limit` - there is no
 *        "has more" flag to trust.
 *
 * Real call:
 *   const res = await fetch(
 *     'https://apigw-prod2.central.arubanetworks.com/monitoring/v2/switches?offset=0&limit=100',
 *     { headers: { Authorization: 'Bearer ' + token } },
 *   );
 *   if (!res.ok) throw new ProviderError('aruba-central', res.status, await res.text());
 *
 * Shape modelled from the published Aruba Central API reference; not captured
 * from a live account. See fixtures.ts.
 *
 * NOTE THE STATUS VOCABULARY: Central says 'Up' and 'Down', capitalised, where
 * Meraki says 'online'/'offline' and Mist says 'connected'/'disconnected'.
 * Three clouds, three words for one idea. Collapsing all three into one
 * `reachability` scalar is the entire point of a canonical model, and it is
 * more obviously worth doing now that all three arrive over the same transport
 * and nothing but this layer distinguishes them.
 */
import type { Connector, ConnectorContext, Resource } from '../connector.ts';
import type { Inventory } from '../../platform/inventory.ts';
import type { Observation } from '../../platform/types.ts';
import type { HttpPage, PageCursor, RawBatch } from '../http.ts';
import { now } from '../../platform/clock.ts';
import { log } from '../../platform/logger.ts';
import { controllerMetric, type ControllerIdentity } from './build.ts';
import { arubaCentralSwitches, maybeFail, pageOf } from './fixtures.ts';

const IDENTITY = (tenantId: string): ControllerIdentity =>
  ({ vendor: 'aruba', platform: 'aruba-central', tenantId });

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

type Token = { value: string; expiresAt: number };
const tokens = new Map<string, Token>();

/**
 * Refresh EARLY, not on expiry.
 *
 * Sixty seconds of headroom, because the alternative fails in the worst
 * possible way: a token that expires mid-poll gives you a 401 on page four of
 * seven, the retry wrapper treats 401 as non-retryable (correctly - a bad token
 * does not improve with waiting), and the run ends with a partial estate and no
 * obvious cause. Refreshing before the cliff makes the whole class of problem
 * disappear.
 *
 * Cached per tenant, not globally: Central's token is scoped to one customer,
 * and a shared cache would hand tenant A's token to tenant B's poll.
 */
function ensureToken(ctx: ConnectorContext): string {
  const existing = tokens.get(ctx.tenantId);
  if (existing && existing.expiresAt - now() > 60_000) return existing.value;

  // The real call is a POST to /oauth2/token with client_credentials. Offline
  // it is deterministic, because a token that changed between runs would make
  // the demo undiffable.
  const fresh: Token = {
    value: 'central-token-' + ctx.tenantId,
    expiresAt: now() + 2 * 60 * 60 * 1000,
  };
  tokens.set(ctx.tenantId, fresh);
  log.debug('aruba-central token refreshed', { tenantId: ctx.tenantId });
  return fresh.value;
}

export function resetTokens(): void { tokens.clear(); }

/**
 * Switch inventory and health.
 *
 * CONTROLLER plane: `status: 'Down'` is Central reporting that the switch
 * stopped checking in with Central. The switch itself said nothing - it cannot,
 * that is what being down means.
 */
const switches: Resource = {
  name: 'switches',
  plane: 'controller',
  firstPage: () => ({ kind: 'offset', offset: 0, limit: 100 }),
  async fetchPage(ctx: ConnectorContext, cursor: PageCursor): Promise<HttpPage> {
    maybeFail('aruba-central');
    ensureToken(ctx);
    return pageOf(arubaCentralSwitches.switches, cursor);
  },
};

type SwitchRow = (typeof arubaCentralSwitches)['switches'][number];

export const arubaCentral: Connector = {
  controller: 'aruba-central',
  vendor: 'aruba',
  platform: 'aruba-central',
  auth: 'oauth2-client-credentials',
  rateLimitPerMin: 420,
  resources: [switches],

  normalise(raw: RawBatch, inventory: Inventory, resource: Resource): Observation[] {
    const identity = IDENTITY(raw.tenantId);
    const out: Observation[] = [];

    for (const record of raw.records) {
      const d = record as SwitchRow;

      const deviceId = inventory.resolveDeviceAny(d.serial, d.name);
      if (!deviceId) continue;

      const siteId = inventory.siteOf(deviceId);
      const up = d.status === 'Up';

      // Central does not timestamp each row; the reply is a snapshot. So the
      // poll time IS the observation time, and saying so explicitly beats
      // inventing a per-device timestamp we do not have.
      const observedAt = raw.receivedAt;
      const common = {
        identity, plane: resource.plane, encoding: raw.encoding,
        deviceId, siteId, sourceRef: d.serial, observedAt, receivedAt: raw.receivedAt,
      };

      out.push(controllerMetric({
        ...common,
        kind: 'reachability',
        value: up ? 1 : 0,
        unit: 'boolean',
        attributes: { model: d.model, centralStatus: d.status, site: d.site },
      }));

      if (up) {
        out.push(controllerMetric({
          ...common, kind: 'cpu-utilisation', value: d.cpu_utilization, unit: 'percent',
        }));
      }
    }

    return out;
  },
};
