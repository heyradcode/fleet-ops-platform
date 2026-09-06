/**
 * Motive (formerly KeepTruckin) ELD API.
 *
 * Auth:  OAuth2 client credentials.
 * Rate:  ~100 requests/minute.
 * Paging: page_no + per_page.
 *
 * Real call:
 *   GET https://api.gomotive.com/v1/hours_of_service_logs?date=2026-09-08
 *   Authorization: Bearer <token>
 *
 * Shape modelled from the published Motive API reference; not captured from a
 * live account. See fixtures.ts.
 *
 * UNITS - the trap this connector exists to absorb. Motive reports remaining
 * time in SECONDS. Omnitracs reports MINUTES. Platform Science reports minutes
 * under a different key again. The canonical `hos-remaining` reading is always
 * minutes, and each connector converts on the way in.
 *
 * Getting this wrong by a factor of 60 does not throw. It silently disables
 * every hours-of-service warning in the platform, because 2040 "minutes"
 * remaining is comfortably above any threshold.
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Telemetry } from '../../platform/types.ts';
import { telemetryId } from '../../platform/ids.ts';
import { nowIso } from '../../platform/clock.ts';
import { motiveHosLogs, maybeFail } from '../fixtures.ts';

export const motive: Connector = {
  provider: 'motive',
  domain: 'eld-hos',
  auth: 'oauth2-client-credentials',
  rateLimitPerMin: 100,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('motive');
    return {
      tenantId: ctx.tenantId,
      provider: 'motive',
      fetchedAt: nowIso(),
      payload: motiveHosLogs,
    };
  },

  normalise(raw): Telemetry[] {
    const body = raw.payload as typeof motiveHosLogs;

    return body.logs.map(({ log }) => {
      const minutes = Math.round(log.driving_time_remaining / 60);
      return {
        tenantId: raw.tenantId,
        telemetryId: telemetryId('motive', log.driver.id + ':hos', log.updated_at),
        provider: 'motive' as const, domain: 'eld-hos' as const,
        kind: 'hos-remaining' as const,
        driverId: log.driver.id, sourceRef: log.driver.username,
        value: minutes, unit: 'minutes' as const,
        severity: severityFor('hos-remaining', minutes),
        observedAt: log.updated_at,
        // An ELD reports a clock, not a position. No `location`, and that is
        // correct - resolveTerritory simply has nothing to do for this reading.
        attributes: {
          dutyStatus: log.current_status,
          shiftMinutesRemaining: Math.round(log.shift_time_remaining / 60),
        },
      };
    });
  },
};
