/**
 * Platform Science ELD API.
 *
 * Auth:  OAuth2 client credentials.
 * Style: snake_case, a `duty_status` collection, ISO timestamps.
 *
 * Real call:
 *   GET https://api.platformscience.com/api/v2/duty-status
 *   Authorization: Bearer <token>
 *
 * Shape modelled from the published Platform Science API reference; not
 * captured from a live account. See fixtures.ts.
 *
 * The third ELD vendor, and the third spelling of the same idea:
 *   Motive            driving_time_remaining        seconds
 *   Omnitracs         minutesDrivingRemaining       minutes
 *   Platform Science  remaining_drive_minutes       minutes
 * One canonical `hos-remaining` in minutes, three conversions, no downstream
 * code that has to care.
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Telemetry } from '../../platform/types.ts';
import { telemetryId } from '../../platform/ids.ts';
import { nowIso } from '../../platform/clock.ts';
import { platformScienceDuty, maybeFail } from '../fixtures.ts';

export const platformScience: Connector = {
  provider: 'platform-science',
  domain: 'eld-hos',
  auth: 'oauth2-client-credentials',
  rateLimitPerMin: 240,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('platform-science');
    return {
      tenantId: ctx.tenantId,
      provider: 'platform-science',
      fetchedAt: nowIso(),
      payload: platformScienceDuty,
    };
  },

  normalise(raw): Telemetry[] {
    const body = raw.payload as typeof platformScienceDuty;

    return body.duty_status.map((d) => ({
      tenantId: raw.tenantId,
      telemetryId: telemetryId('platform-science', d.driver_ref + ':hos', d.recorded_at),
      provider: 'platform-science' as const, domain: 'eld-hos' as const,
      kind: 'hos-remaining' as const,
      driverId: d.driver_ref, sourceRef: d.driver_ref,
      value: d.remaining_drive_minutes, unit: 'minutes' as const,
      severity: severityFor('hos-remaining', d.remaining_drive_minutes),
      observedAt: d.recorded_at,
      attributes: { dutyStatus: d.status, dutyMinutesRemaining: d.remaining_duty_minutes },
    }));
  },
};
