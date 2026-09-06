/**
 * Netradyne Driveri API.
 *
 * Auth:  Bearer token.
 * Style: an `alerts` collection. Timestamps are EPOCH MILLISECONDS, not ISO
 *        strings - the sort of difference that is invisible in a unit test and
 *        obvious the first time a chart puts every event in 1970.
 *
 * Real call:
 *   GET https://api.netradyne.com/v1/alerts?startTime=...&endTime=...
 *   Authorization: Bearer <token>
 *
 * Shape modelled from the published Netradyne API reference; not captured from
 * a live account. See fixtures.ts.
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Telemetry } from '../../platform/types.ts';
import { telemetryId } from '../../platform/ids.ts';
import { nowIso } from '../../platform/clock.ts';
import { netradyneAlerts, maybeFail } from '../fixtures.ts';

export const netradyne: Connector = {
  provider: 'netradyne',
  domain: 'video-safety',
  auth: 'bearer-token',
  rateLimitPerMin: 120,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('netradyne');
    return {
      tenantId: ctx.tenantId,
      provider: 'netradyne',
      fetchedAt: nowIso(),
      payload: netradyneAlerts,
    };
  },

  normalise(raw): Telemetry[] {
    const body = raw.payload as typeof netradyneAlerts;
    const out: Telemetry[] = [];

    for (const a of body.alerts) {
      if (a.alertType !== 'PROLONGED_IDLE') continue;

      // Epoch millis -> ISO. Every canonical timestamp in the platform is
      // ISO-8601, so this conversion happens exactly here and nowhere else.
      const observedAt = new Date(a.alertTimeMs).toISOString();
      const minutes = Math.round(a.durationSeconds / 60);

      out.push({
        tenantId: raw.tenantId,
        telemetryId: telemetryId('netradyne', a.alertId, observedAt),
        provider: 'netradyne', domain: 'video-safety', kind: 'idle',
        driverId: a.driverIdentifier, sourceRef: a.alertId,
        value: minutes, unit: 'minutes',
        severity: severityFor('idle', minutes),
        observedAt,
        location: { lon: a.gps.lon, lat: a.gps.lat, district: '' },
        attributes: { alertType: a.alertType, netradyneSeverity: a.severity },
      });
    }
    return out;
  },
};
