/**
 * Cisco Meraki Dashboard API.
 *
 * Auth:  X-Cisco-Meraki-API-Key header (a long-lived key -> Secrets Manager).
 * Rate:  5 requests/second per organisation, enforced with 429 + Retry-After.
 * Paging: cursor-based via the `Link` header (rel="next"), NOT page numbers.
 *
 * Real call:
 *   const res = await fetch(
 *     `https://api.meraki.com/api/v1/organizations/${orgId}/devices/statuses`,
 *     { headers: { 'X-Cisco-Meraki-API-Key': key, Accept: 'application/json' } },
 *   );
 *   if (!res.ok) throw new ProviderError('cisco-meraki', res.status, await res.text());
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Signal } from '../../platform/types.ts';
import { signalId } from '../../platform/ids.ts';
import { merakiDeviceStatuses, maybeFail } from '../fixtures.ts';

/** Meraki networkId -> our siteId. Real systems keep this map in DynamoDB. */
const NETWORK_TO_SITE: Record<string, string> = {
  N_dal_01: 'dal-01', N_aus_01: 'aus-01', N_den_01: 'den-01',
};

export const ciscoMeraki: Connector = {
  provider: 'cisco-meraki',
  domain: 'network',
  auth: 'api-key-header',
  rateLimitPerMin: 300,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('cisco-meraki');
    return {
      tenantId: ctx.tenantId,
      provider: 'cisco-meraki',
      fetchedAt: new Date().toISOString(),
      payload: merakiDeviceStatuses,
    };
  },

  normalise(raw): Signal[] {
    const body = raw.payload as typeof merakiDeviceStatuses;
    const signals: Signal[] = [];

    for (const d of body.items) {
      const siteId = NETWORK_TO_SITE[d.networkId] ?? 'unknown';
      const observedAt = d.lastReportedAt;

      // One device row yields TWO canonical signals. Splitting them means the
      // agent can reason about latency and loss independently, and each gets
      // its own severity threshold.
      signals.push({
        tenantId: raw.tenantId,
        signalId: signalId('cisco-meraki', d.serial + ':latency', observedAt),
        provider: 'cisco-meraki', domain: 'network', kind: 'wan-latency',
        siteId, sourceRef: d.serial,
        value: d.latencyMs, unit: 'ms',
        severity: severityFor('wan-latency', d.latencyMs),
        observedAt,
        attributes: { deviceName: d.name, merakiStatus: d.status },
      });

      signals.push({
        tenantId: raw.tenantId,
        signalId: signalId('cisco-meraki', d.serial + ':loss', observedAt),
        provider: 'cisco-meraki', domain: 'network', kind: 'packet-loss',
        siteId, sourceRef: d.serial,
        value: d.lossPercent, unit: 'percent',
        severity: severityFor('packet-loss', d.lossPercent),
        observedAt,
        attributes: { deviceName: d.name, merakiStatus: d.status },
      });
    }
    return signals;
  },
};
