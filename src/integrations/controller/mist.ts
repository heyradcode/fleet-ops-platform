/**
 * Juniper Mist API.
 *
 * Auth:  `Authorization: Token <key>` -> Secrets Manager.
 * Rate:  ~5000 requests/hour per org; 429 with Retry-After.
 * Paging: `page` and `limit` query parameters - ONE-INDEXED, and the total
 *        comes back in `X-Page-Total`. Starting at page 0 silently returns the
 *        first page twice and drops the last one.
 *
 * Real call:
 *   const res = await fetch(
 *     'https://api.mist.com/api/v1/sites/' + siteId + '/stats/devices?page=1&limit=100',
 *     { headers: { Authorization: 'Token ' + key } },
 *   );
 *   if (!res.ok) throw new ProviderError('mist', res.status, await res.text());
 *
 * Shape modelled from the published Mist API reference; not captured from a
 * live account. See fixtures.ts.
 *
 * THE UNIT TRAP, in its cloud form: Mist reports `last_seen` as UNIX SECONDS
 * while Meraki sends ISO-8601 and Central sends nothing per-row at all. Nothing
 * downstream should ever have to know that, which is precisely what this file
 * is for. Getting it wrong does not throw - it files an access point's status
 * in 1970 and quietly excludes it from every correlation window.
 */
import type { Connector, ConnectorContext, Resource } from '../connector.ts';
import type { Inventory } from '../../platform/inventory.ts';
import type { Observation } from '../../platform/types.ts';
import type { HttpPage, PageCursor, RawBatch } from '../http.ts';
import { controllerMetric, type ControllerIdentity } from './build.ts';
import { mistDeviceStats, maybeFail, pageOf } from './fixtures.ts';

const IDENTITY = (tenantId: string): ControllerIdentity =>
  ({ vendor: 'juniper', platform: 'mist', tenantId });

/** Mist sends seconds; everything in this platform is ISO-8601 milliseconds. */
function fromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

/**
 * Device statistics.
 *
 * CONTROLLER plane. `status: 'disconnected'` is Mist saying the AP stopped
 * talking to Mist - which is a real and useful observation, and is NOT the same
 * as the AP reporting a fault about itself. Mist's separate alarm feed would be
 * the device plane; this endpoint is not it.
 */
const deviceStats: Resource = {
  name: 'device-stats',
  plane: 'controller',
  // ONE-indexed. See the header.
  firstPage: () => ({ kind: 'page', page: 1, limit: 100 }),
  async fetchPage(_ctx: ConnectorContext, cursor: PageCursor): Promise<HttpPage> {
    maybeFail('mist');
    return pageOf(mistDeviceStats.results, cursor);
  },
};

type StatRow = (typeof mistDeviceStats)['results'][number];

export const mist: Connector = {
  controller: 'mist',
  vendor: 'juniper',
  platform: 'mist',
  auth: 'bearer-token',
  rateLimitPerMin: 83,
  resources: [deviceStats],

  normalise(raw: RawBatch, inventory: Inventory, resource: Resource): Observation[] {
    const identity = IDENTITY(raw.tenantId);
    const out: Observation[] = [];

    for (const record of raw.records) {
      const d = record as StatRow;

      const deviceId = inventory.resolveDeviceAny(d.mac, d.name);
      if (!deviceId) continue;

      const siteId = inventory.siteOf(deviceId);
      const observedAt = fromUnixSeconds(d.last_seen);
      const common = {
        identity, plane: resource.plane, encoding: raw.encoding,
        deviceId, siteId, sourceRef: d.mac, observedAt, receivedAt: raw.receivedAt,
      };

      out.push(controllerMetric({
        ...common,
        kind: 'reachability',
        value: d.status === 'connected' ? 1 : 0,
        unit: 'boolean',
        attributes: { mistStatus: d.status, type: d.type },
      }));

      // Client count only means anything on a radio that is actually up. A
      // disconnected AP reports zero clients, and publishing that as a healthy
      // reading is how a dashboard shows a dead access point as merely quiet.
      if (d.status === 'connected') {
        out.push(controllerMetric({ ...common, kind: 'ap-client-count', value: d.num_clients, unit: 'count' }));
        out.push(controllerMetric({ ...common, kind: 'cpu-utilisation', value: d.cpu_util, unit: 'percent' }));
      }
    }

    return out;
  },
};
