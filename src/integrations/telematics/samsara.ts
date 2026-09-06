/**
 * Samsara Fleet API.
 *
 * Auth:  Bearer token (long-lived API token -> Secrets Manager).
 * Rate:  ~25 requests/second per organisation; 429 with Retry-After.
 * Paging: cursor-based via `pagination.endCursor`, NOT page numbers.
 *
 * Real call:
 *   const res = await fetch(
 *     'https://api.samsara.com/fleet/vehicles/stats?types=gps,engineStates',
 *     { headers: { Authorization: `Bearer ${token}` } },
 *   );
 *   if (!res.ok) throw new ProviderError('samsara', res.status, await res.text());
 *
 * Shape modelled from the published Samsara API reference; not captured from a
 * live account. See fixtures.ts.
 *
 * THE UNIT TRAP: Samsara reports speed in MILES per hour. Geotab reports
 * kilometres. Nothing downstream should ever have to know that, which is
 * precisely what this file is for.
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Telemetry } from '../../platform/types.ts';
import { telemetryId } from '../../platform/ids.ts';
import { nowIso } from '../../platform/clock.ts';
import { samsaraVehicleStats, maybeFail } from '../fixtures.ts';

const MPH_TO_KPH = 1.609344;

export const samsara: Connector = {
  provider: 'samsara',
  domain: 'telematics',
  auth: 'bearer-token',
  rateLimitPerMin: 1_500,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('samsara');
    return {
      tenantId: ctx.tenantId,
      provider: 'samsara',
      fetchedAt: nowIso(),
      payload: samsaraVehicleStats,
    };
  },

  normalise(raw): Telemetry[] {
    const body = raw.payload as typeof samsaraVehicleStats;
    const out: Telemetry[] = [];

    for (const v of body.data) {
      const driverId = v.externalIds.driverId;

      // One vehicle row yields several canonical readings. Splitting them means
      // the agent can reason about position and braking independently, and each
      // gets its own severity threshold.
      const speedKph = Number((v.gps.speedMilesPerHour * MPH_TO_KPH).toFixed(1));
      out.push({
        tenantId: raw.tenantId,
        telemetryId: telemetryId('samsara', v.id + ':gps', v.gps.time),
        provider: 'samsara', domain: 'telematics', kind: 'position',
        driverId, sourceRef: v.id,
        value: speedKph, unit: 'kph',
        severity: severityFor('position', speedKph),
        observedAt: v.gps.time,
        // [lon, lat] everywhere. Samsara sends them the other way round, which
        // is the single easiest place in this codebase to introduce a bug that
        // does not throw - it just puts Dallas in Antarctica.
        location: { lon: v.gps.longitude, lat: v.gps.latitude, district: '' },
        attributes: {
          vehicleName: v.name,
          heading: v.gps.headingDegrees,
          engineState: v.engineStates.value,
          nearestAddress: v.gps.reverseGeo.formattedLocation,
        },
      });

      if (v.harshEvent) {
        out.push({
          tenantId: raw.tenantId,
          telemetryId: telemetryId('samsara', v.id + ':harsh', v.harshEvent.time),
          provider: 'samsara', domain: 'telematics', kind: 'harsh-brake',
          driverId, sourceRef: v.id,
          value: v.harshEvent.gForce, unit: 'g',
          severity: severityFor('harsh-brake', v.harshEvent.gForce),
          observedAt: v.harshEvent.time,
          location: { lon: v.gps.longitude, lat: v.gps.latitude, district: '' },
          attributes: { vehicleName: v.name, label: v.harshEvent.behaviourLabel },
        });
      }
    }
    return out;
  },
};
