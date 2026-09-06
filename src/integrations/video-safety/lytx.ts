/**
 * Lytx DriveCam API.
 *
 * Auth:  API key header.
 * Style: an `events` collection where each event carries a NESTED ARRAY of
 *        detected behaviours - one dashcam trigger can report several at once.
 *
 * Real call:
 *   GET https://lytx-api.prod7.lv.lytx.com/video/v2/events
 *   x-apikey: <key>
 *
 * Shape modelled from the published Lytx API reference; not captured from a
 * live account. See fixtures.ts.
 *
 * WHY THIS CONNECTOR MATTERS DISPROPORTIONATELY: it is the second, independent
 * witness. A Samsara accelerometer and a Lytx dashcam are different hardware
 * from different vendors. When both report hard braking for the same driver at
 * the same instant, that is corroboration and worth a safety review. One feed
 * reporting the same thing twice is not - it is a sensor with a stuck reading.
 *
 * That distinction is the entire basis of detectIncidents, and no single
 * connector could ever establish it alone.
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Telemetry } from '../../platform/types.ts';
import { telemetryId } from '../../platform/ids.ts';
import { nowIso } from '../../platform/clock.ts';
import { lytxEvents, maybeFail } from '../fixtures.ts';

export const lytx: Connector = {
  provider: 'lytx',
  domain: 'video-safety',
  auth: 'api-key-header',
  rateLimitPerMin: 180,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('lytx');
    return {
      tenantId: ctx.tenantId,
      provider: 'lytx',
      fetchedAt: nowIso(),
      payload: lytxEvents,
    };
  },

  normalise(raw): Telemetry[] {
    const body = raw.payload as typeof lytxEvents;
    const out: Telemetry[] = [];

    for (const e of body.events) {
      // Only the braking behaviour maps to a canonical reading today. The other
      // behaviours are preserved as attributes rather than invented into new
      // kinds - adding a TelemetryKind is a schema change every consumer sees,
      // and should be a deliberate decision, not a side effect of one vendor
      // having a richer taxonomy than the others.
      // The panic button is physically on the dashcam, so it arrives here.
      // It is the one reading that must never wait for a batch window or a
      // second opinion - see NEEDS_NO_CORROBORATION in pipeline/steps.ts.
      const panic = e.behaviors.find((b) => b.name === 'Panic Button');
      if (panic) {
        out.push({
          tenantId: raw.tenantId,
          telemetryId: telemetryId('lytx', e.eventId, e.recordDateTime),
          provider: 'lytx', domain: 'video-safety', kind: 'panic',
          driverId: e.driverId, sourceRef: e.vehicleId,
          value: 1, unit: 'boolean',
          severity: 'critical',
          observedAt: e.recordDateTime,
          location: { lon: e.longitude, lat: e.latitude, district: '' },
          attributes: { behaviour: panic.name, reviewStatus: e.status },
        });
        continue;
      }

      const braking = e.behaviors.find((b) => b.name.startsWith('Braking'));
      if (!braking) continue;

      out.push({
        tenantId: raw.tenantId,
        telemetryId: telemetryId('lytx', e.eventId, e.recordDateTime),
        provider: 'lytx', domain: 'video-safety', kind: 'harsh-brake',
        driverId: e.driverId, sourceRef: e.vehicleId,
        value: e.triggerGForce, unit: 'g',
        severity: severityFor('harsh-brake', e.triggerGForce),
        observedAt: e.recordDateTime,
        location: { lon: e.longitude, lat: e.latitude, district: '' },
        attributes: {
          behaviour: braking.name,
          lytxSeverity: braking.severity,
          otherBehaviours: e.behaviors.map((b) => b.name).join(', '),
          reviewStatus: e.status,
        },
      });
    }
    return out;
  },
};
