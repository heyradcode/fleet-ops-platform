/**
 * Cisco Meraki Dashboard API.
 *
 * Auth:  X-Cisco-Meraki-API-Key header (a long-lived key -> Secrets Manager).
 * Rate:  5 requests/second per organisation, enforced with 429 + Retry-After.
 * Paging: cursor-based via the `Link` header (rel="next"), NOT page numbers.
 *
 * Real call:
 *   const res = await fetch(
 *     'https://api.meraki.com/api/v1/organizations/' + orgId + '/devices/statuses',
 *     { headers: { 'X-Cisco-Meraki-API-Key': key, Accept: 'application/json' } },
 *   );
 *   if (!res.ok) throw new ProviderError('meraki', res.status, await res.text());
 *
 * Shape modelled from the published Meraki API reference; not captured from a
 * live account. See fixtures.ts.
 *
 * WHAT THIS IS FOR. Meraki is Cisco, and most of the estate's Cisco kit already
 * tells us about itself over syslog. This connector is not here to repeat that.
 * It is here because `status: 'offline'` is the CONTROLLER's opinion of a
 * device, formed independently of anything the device says - and a device that
 * has stopped talking cannot report its own silence. That makes this the second
 * witness the corroboration rule needs, and in a hard-down case the only one.
 */
import type { Connector } from '../connector.ts';
import type { Inventory } from '../../platform/inventory.ts';
import type { Observation } from '../../platform/types.ts';
import type { RawBatch } from '../wire.ts';
import { nowIso } from '../../platform/clock.ts';
import { controllerMetric, controllerEvent } from './build.ts';
import { merakiDeviceStatuses, maybeFail } from './fixtures.ts';

export const meraki: Connector = {
  controller: 'meraki',
  vendor: 'cisco',
  platform: 'meraki',
  auth: 'api-key-header',
  rateLimitPerMin: 300,

  async fetchRaw(ctx): Promise<RawBatch> {
    maybeFail('meraki');
    return {
      tenantId: ctx.tenantId,
      encoding: 'rest-json',
      receivedAt: nowIso(),
      source: { collector: 'meraki-poller' },
      records: merakiDeviceStatuses.data,
    };
  },

  normalise(raw: RawBatch, inventory: Inventory): Observation[] {
    const out: Observation[] = [];

    for (const record of raw.records) {
      const d = record as (typeof merakiDeviceStatuses)['data'][number];

      // The serial is Meraki's handle, not ours. It resolves only because the
      // estate records it as a controller-id alias; keying on it directly is
      // what leaves one box represented twice under two different names.
      const deviceId = inventory.resolveDevice(d.serial) ?? inventory.resolveDevice(d.name);
      if (!deviceId) continue;

      const siteId = inventory.siteOf(deviceId);
      const reachable = d.status === 'online' ? 1 : 0;

      out.push(controllerMetric({
        identity: { vendor: 'cisco', platform: 'meraki', tenantId: raw.tenantId },
        deviceId, siteId,
        sourceRef: d.serial,
        kind: 'reachability',
        value: reachable,
        unit: 'boolean',
        observedAt: d.lastReportedAt,
        receivedAt: raw.receivedAt,
        attributes: { model: d.model, productType: d.productType, merakiStatus: d.status },
      }));

      // 'alerting' is Meraki's own word for "up but unhappy", and it does not
      // map onto reachable/unreachable at all. Recording it as an event rather
      // than forcing it into the reachability scalar is the metric/event fork
      // doing its job.
      if (d.status === 'alerting') {
        out.push(controllerEvent({
          identity: { vendor: 'cisco', platform: 'meraki', tenantId: raw.tenantId },
          deviceId, siteId,
          sourceRef: d.serial,
          kind: 'power-supply', state: 'failed',
          message: 'Meraki reports device alerting',
          observedAt: d.lastReportedAt,
          receivedAt: raw.receivedAt,
        }));
      }
    }

    return out;
  },
};
