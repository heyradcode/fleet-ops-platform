/**
 * Juniper Mist Cloud API.
 *
 * Auth:  Authorization: Token <api-token>  (Mist calls it a "token", it is a
 *        static API key - so again Secrets Manager, rotated on a schedule).
 * Note:  Mist timestamps are UNIX SECONDS, not ISO strings. Every integration
 *        has one of these traps; unit-test the conversion.
 *
 * Real call:
 *   GET https://api.mist.com/api/v1/sites/{siteId}/stats/devices
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Signal } from '../../platform/types.ts';
import { signalId } from '../../platform/ids.ts';
import { mistDeviceStats, maybeFail } from '../fixtures.ts';

export const juniperMist: Connector = {
  provider: 'juniper-mist',
  domain: 'network',
  auth: 'bearer-token',
  rateLimitPerMin: 5000,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('juniper-mist');
    return {
      tenantId: ctx.tenantId,
      provider: 'juniper-mist',
      fetchedAt: new Date().toISOString(),
      payload: mistDeviceStats,
    };
  },

  normalise(raw): Signal[] {
    const body = raw.payload as typeof mistDeviceStats;

    return body.results.map((d) => {
      // Mist gives CPU utilisation; our canonical kind is "health", where
      // HIGHER is better. Invert so one threshold rule covers every vendor.
      const health = Math.max(0, 100 - d.cpu_util);
      const observedAt = new Date(d.last_seen * 1000).toISOString();

      return {
        tenantId: raw.tenantId,
        signalId: signalId('juniper-mist', d.mac, observedAt),
        provider: 'juniper-mist', domain: 'network', kind: 'device-health',
        siteId: d.site_id, sourceRef: d.mac,
        value: health, unit: 'percent',
        severity: severityFor('device-health', health),
        observedAt,
        attributes: {
          deviceName: d.name, cpuUtil: d.cpu_util,
          memUtil: d.mem_util, uptimeSeconds: d.uptime,
        },
      } satisfies Signal;
    });
  },
};
