/**
 * Omnitracs (Solera) Hours of Service API.
 *
 * Auth:  API key header + company id.
 * Style: flat records under `hosData`, with duty status as an FMCSA single
 *        letter - 'D' driving, 'ON' on-duty, 'SB' sleeper berth.
 *
 * Real call:
 *   GET https://api.omnitracs.com/hos/v2/driverLogs?companyId=...
 *   x-api-key: <key>
 *
 * Shape modelled from the published Omnitracs API reference; not captured from
 * a live account. See fixtures.ts.
 *
 * Reports MINUTES where Motive reports seconds - see motive.ts for why that
 * difference is worth a comment in both files.
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Telemetry } from '../../platform/types.ts';
import { telemetryId } from '../../platform/ids.ts';
import { nowIso } from '../../platform/clock.ts';
import { omnitracsHos, maybeFail } from '../fixtures.ts';

/** FMCSA duty-status codes, spelled out for whoever reads the attributes. */
const DUTY: Record<string, string> = {
  D: 'driving', ON: 'on-duty', OFF: 'off-duty', SB: 'sleeper-berth',
};

export const omnitracs: Connector = {
  provider: 'omnitracs',
  domain: 'eld-hos',
  auth: 'api-key-header',
  rateLimitPerMin: 120,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('omnitracs');
    return {
      tenantId: ctx.tenantId,
      provider: 'omnitracs',
      fetchedAt: nowIso(),
      payload: omnitracsHos,
    };
  },

  normalise(raw): Telemetry[] {
    const body = raw.payload as typeof omnitracsHos;

    return body.hosData.map((d) => ({
      tenantId: raw.tenantId,
      telemetryId: telemetryId('omnitracs', d.driverId + ':hos', d.timestampUtc),
      provider: 'omnitracs' as const, domain: 'eld-hos' as const,
      kind: 'hos-remaining' as const,
      driverId: d.driverId, sourceRef: d.driverId,
      value: d.minutesDrivingRemaining, unit: 'minutes' as const,   // already minutes
      severity: severityFor('hos-remaining', d.minutesDrivingRemaining),
      observedAt: d.timestampUtc,
      attributes: {
        dutyStatus: DUTY[d.dutyStatus] ?? d.dutyStatus,
        minutesUntilBreak: d.minutesUntilBreakRequired,
      },
    }));
  },
};
