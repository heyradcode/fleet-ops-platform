/**
 * Juniper Mist API.
 *
 * Auth:  Token header (`Authorization: Token <key>`) -> Secrets Manager.
 * Rate:  ~5000 requests/hour per org; 429 with Retry-After.
 * Paging: `page` and `limit` query parameters.
 *
 * Real call:
 *   const res = await fetch(
 *     'https://api.mist.com/api/v1/sites/' + siteId + '/stats/devices',
 *     { headers: { Authorization: 'Token ' + key } },
 *   );
 *   if (!res.ok) throw new ProviderError('mist', res.status, await res.text());
 *
 * Shape modelled from the published Mist API reference; not captured from a
 * live account. See fixtures.ts.
 *
 * THE UNIT TRAP, in its network form: Mist reports `last_seen` as UNIX seconds
 * while Meraki sends ISO-8601 and the switches send syslog timestamps. Nothing
 * downstream should ever have to know that, which is precisely what this file
 * is for. Getting it wrong does not throw - it files an access point's status
 * in 1970 and quietly excludes it from every correlation window.
 */
import type { Connector } from '../connector.ts';
import type { Inventory } from '../../platform/inventory.ts';
import type { Observation } from '../../platform/types.ts';
import type { RawBatch } from '../wire.ts';
import { nowIso } from '../../platform/clock.ts';
import { controllerMetric } from './build.ts';
import { mistDeviceStats, maybeFail } from './fixtures.ts';

/** Mist sends seconds; everything in this platform is ISO-8601 milliseconds. */
function fromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

export const mist: Connector = {
  controller: 'mist',
  vendor: 'juniper',
  platform: 'mist',
  auth: 'bearer-token',
  rateLimitPerMin: 83,

  async fetchRaw(ctx): Promise<RawBatch> {
    maybeFail('mist');
    return {
      tenantId: ctx.tenantId,
      encoding: 'rest-json',
      receivedAt: nowIso(),
      source: { collector: 'mist-poller' },
      records: mistDeviceStats.results,
    };
  },

  normalise(raw: RawBatch, inventory: Inventory): Observation[] {
    const out: Observation[] = [];

    for (const record of raw.records) {
      const d = record as (typeof mistDeviceStats)['results'][number];

      const deviceId = inventory.resolveDevice(d.mac) ?? inventory.resolveDevice(d.name);
      if (!deviceId) continue;

      const siteId = inventory.siteOf(deviceId);
      const identity = { vendor: 'juniper' as const, platform: 'mist' as const, tenantId: raw.tenantId };
      const observedAt = fromUnixSeconds(d.last_seen);

      out.push(controllerMetric({
        identity, deviceId, siteId,
        sourceRef: d.mac,
        kind: 'reachability',
        value: d.status === 'connected' ? 1 : 0,
        unit: 'boolean',
        observedAt,
        receivedAt: raw.receivedAt,
        attributes: { mistStatus: d.status, type: d.type },
      }));

      // Client count only means anything on a radio that is actually up. A
      // disconnected AP reports zero clients, and publishing that as a healthy
      // reading is how a dashboard shows a dead access point as merely quiet.
      if (d.status === 'connected') {
        out.push(controllerMetric({
          identity, deviceId, siteId,
          sourceRef: d.mac,
          kind: 'ap-client-count',
          value: d.num_clients,
          unit: 'count',
          observedAt,
          receivedAt: raw.receivedAt,
        }));

        out.push(controllerMetric({
          identity, deviceId, siteId,
          sourceRef: d.mac,
          kind: 'cpu-utilisation',
          value: d.cpu_util,
          unit: 'percent',
          observedAt,
          receivedAt: raw.receivedAt,
        }));
      }
    }

    return out;
  },
};
