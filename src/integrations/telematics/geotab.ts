/**
 * Geotab MyGeotab API.
 *
 * Auth:  session-based - Authenticate once, then pass credentials on each call.
 * Rate:  ~1 request/second sustained per database; bursts tolerated.
 * Style: JSON-RPC over POST /apiv1, not REST. Everything is { method, params },
 *        and results come back under `result`.
 *
 * Real call:
 *   await fetch('https://my.geotab.com/apiv1', {
 *     method: 'POST',
 *     body: JSON.stringify({ method: 'Get', params: {
 *       typeName: 'DeviceStatusInfo', credentials } }),
 *   });
 *
 * Shape modelled from the published MyGeotab SDK reference. Geotab is the one
 * vendor here with a public demo database, so this shape is the best-verified
 * of the eight.
 *
 * Geotab is metric: `speed` is already km/h. Samsara is not. Absorbing that
 * difference here is the whole point of normalise().
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Telemetry } from '../../platform/types.ts';
import { telemetryId } from '../../platform/ids.ts';
import { nowIso } from '../../platform/clock.ts';
import { geotabDeviceStatusInfo, maybeFail } from '../fixtures.ts';

export const geotab: Connector = {
  provider: 'geotab',
  domain: 'telematics',
  auth: 'basic',
  rateLimitPerMin: 60,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('geotab');
    return {
      tenantId: ctx.tenantId,
      provider: 'geotab',
      fetchedAt: nowIso(),
      payload: geotabDeviceStatusInfo,
    };
  },

  normalise(raw): Telemetry[] {
    const body = raw.payload as typeof geotabDeviceStatusInfo;

    return body.result.map((d) => ({
      tenantId: raw.tenantId,
      telemetryId: telemetryId('geotab', d.device.id + ':gps', d.dateTime),
      provider: 'geotab' as const, domain: 'telematics' as const, kind: 'position' as const,
      driverId: d.driver.id, sourceRef: d.device.serialNumber,
      value: d.speed, unit: 'kph' as const,       // already metric
      severity: severityFor('position', d.speed),
      observedAt: d.dateTime,
      location: { lon: d.longitude, lat: d.latitude, district: '' },
      attributes: {
        driverName: d.driver.name,
        communicating: d.isDeviceCommunicating,
        stateDuration: d.currentStateDuration,
      },
    }));
  },
};
