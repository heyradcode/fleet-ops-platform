/**
 * HPE Aruba Central API.
 *
 * Auth:  OAuth2 client credentials -> a bearer token with a ~2h lifetime, so
 *        unlike the other two this connector has a refresh to get wrong.
 * Rate:  ~7 requests/second per customer; 429 with Retry-After.
 * Paging: `offset` and `limit` query parameters.
 *
 * Real call:
 *   const res = await fetch(
 *     'https://apigw-prod2.central.arubanetworks.com/monitoring/v2/switches',
 *     { headers: { Authorization: 'Bearer ' + token } },
 *   );
 *   if (!res.ok) throw new ProviderError('aruba-central', res.status, await res.text());
 *
 * Shape modelled from the published Aruba Central API reference; not captured
 * from a live account. See fixtures.ts.
 *
 * NOTE THE STATUS VOCABULARY: Central says 'Up' and 'Down', capitalised, where
 * Meraki says 'online'/'offline' and Mist says 'connected'/'disconnected'.
 * Three controllers, three words for one idea, and none of them is what the
 * switches themselves say over syslog. Collapsing all four into one
 * `reachability` scalar is the entire point of a canonical model.
 */
import type { Connector } from '../connector.ts';
import type { Inventory } from '../../platform/inventory.ts';
import type { Observation } from '../../platform/types.ts';
import type { RawBatch } from '../wire.ts';
import { nowIso } from '../../platform/clock.ts';
import { controllerMetric } from './build.ts';
import { arubaCentralSwitches, maybeFail } from './fixtures.ts';

export const arubaCentral: Connector = {
  controller: 'aruba-central',
  vendor: 'aruba',
  platform: 'aruba-central',
  auth: 'oauth2-client-credentials',
  rateLimitPerMin: 420,

  async fetchRaw(ctx): Promise<RawBatch> {
    maybeFail('aruba-central');
    return {
      tenantId: ctx.tenantId,
      encoding: 'rest-json',
      receivedAt: nowIso(),
      source: { collector: 'central-poller' },
      records: arubaCentralSwitches.switches,
    };
  },

  normalise(raw: RawBatch, inventory: Inventory): Observation[] {
    const out: Observation[] = [];

    for (const record of raw.records) {
      const d = record as (typeof arubaCentralSwitches)['switches'][number];

      const deviceId = inventory.resolveDevice(d.serial) ?? inventory.resolveDevice(d.name);
      if (!deviceId) continue;

      const siteId = inventory.siteOf(deviceId);
      const identity = {
        vendor: 'aruba' as const, platform: 'aruba-central' as const, tenantId: raw.tenantId,
      };
      const up = d.status === 'Up';

      // Central does not timestamp each row; the reply is a snapshot. So the
      // poll time IS the observation time, and saying so explicitly beats
      // inventing a per-device timestamp we do not have.
      const observedAt = raw.receivedAt;

      out.push(controllerMetric({
        identity, deviceId, siteId,
        sourceRef: d.serial,
        kind: 'reachability',
        value: up ? 1 : 0,
        unit: 'boolean',
        observedAt,
        receivedAt: raw.receivedAt,
        attributes: { model: d.model, centralStatus: d.status, site: d.site },
      }));

      if (up) {
        out.push(controllerMetric({
          identity, deviceId, siteId,
          sourceRef: d.serial,
          kind: 'cpu-utilisation',
          value: d.cpu_utilization,
          unit: 'percent',
          observedAt,
          receivedAt: raw.receivedAt,
        }));
      }
    }

    return out;
  },
};
