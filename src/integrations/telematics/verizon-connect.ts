/**
 * Verizon Connect Reveal API.
 *
 * Auth:  Basic, then a short-lived token.
 * Style: PascalCase field names and an `Items` envelope - a .NET heritage that
 *        shows through the JSON. Nothing downstream should ever see it.
 *
 * Real call:
 *   GET https://fim.eu.fleetmatics.com/rad/v1/vehicles/status
 *   Authorization: Atmosphere atmosphere_app_id=..., Bearer=...
 *
 * Shape modelled from the published Reveal API reference; not captured from a
 * live account. See fixtures.ts.
 *
 * This vendor is the only one of the eight that reports the POSTED SPEED LIMIT
 * alongside the observed speed, which is what makes a 'speeding' reading
 * possible at all. Where a vendor cannot tell you the limit, the platform has
 * to join against map data instead - a capability difference normalise() cannot
 * paper over and should not pretend to.
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Telemetry } from '../../platform/types.ts';
import { telemetryId } from '../../platform/ids.ts';
import { nowIso } from '../../platform/clock.ts';
import { verizonConnectVehicles, maybeFail } from '../fixtures.ts';

export const verizonConnect: Connector = {
  provider: 'verizon-connect',
  domain: 'telematics',
  auth: 'basic',
  rateLimitPerMin: 300,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('verizon-connect');
    return {
      tenantId: ctx.tenantId,
      provider: 'verizon-connect',
      fetchedAt: nowIso(),
      payload: verizonConnectVehicles,
    };
  },

  normalise(raw): Telemetry[] {
    const body = raw.payload as typeof verizonConnectVehicles;
    const out: Telemetry[] = [];

    for (const v of body.Items) {
      out.push({
        tenantId: raw.tenantId,
        telemetryId: telemetryId('verizon-connect', v.VehicleNumber + ':gps', v.UpdateUTC),
        provider: 'verizon-connect', domain: 'telematics', kind: 'position',
        driverId: v.DriverNumber, sourceRef: v.VehicleNumber,
        value: v.Speed, unit: 'kph',
        severity: severityFor('position', v.Speed),
        observedAt: v.UpdateUTC,
        location: { lon: v.Longitude, lat: v.Latitude, district: '' },
        attributes: { city: v.Address.City, state: v.Address.State },
      });

      const over = v.Speed - v.SpeedLimit;
      if (over > 0) {
        out.push({
          tenantId: raw.tenantId,
          telemetryId: telemetryId('verizon-connect', v.VehicleNumber + ':speeding', v.UpdateUTC),
          provider: 'verizon-connect', domain: 'telematics', kind: 'speeding',
          driverId: v.DriverNumber, sourceRef: v.VehicleNumber,
          value: over, unit: 'kph',
          severity: severityFor('speeding', over),
          observedAt: v.UpdateUTC,
          location: { lon: v.Longitude, lat: v.Latitude, district: '' },
          attributes: { observedKph: v.Speed, postedLimitKph: v.SpeedLimit },
        });
      }
    }
    return out;
  },
};
