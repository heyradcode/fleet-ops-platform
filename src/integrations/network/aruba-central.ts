/**
 * HPE Aruba Central.
 *
 * Auth:  OAuth2 - and unusually, the refresh token ROTATES on every refresh.
 *        If two Lambdas refresh concurrently, one of them is left holding a
 *        dead token. Guard the refresh with a DynamoDB conditional write (or
 *        a short SQS FIFO lock) so exactly one refresher wins.
 *
 * Real flow:
 *   POST /oauth2/token?client_id=..&client_secret=..&grant_type=refresh_token
 *   -> { access_token, refresh_token }   // store the NEW refresh_token
 *   GET  /monitoring/v2/aps  Authorization: Bearer <access_token>
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Signal } from '../../platform/types.ts';
import { signalId } from '../../platform/ids.ts';
import { arubaAccessPoints, maybeFail } from '../fixtures.ts';

export const arubaCentral: Connector = {
  provider: 'aruba-central',
  domain: 'network',
  auth: 'oauth2-client-credentials',
  rateLimitPerMin: 3000,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('aruba-central');
    return {
      tenantId: ctx.tenantId,
      provider: 'aruba-central',
      fetchedAt: new Date().toISOString(),
      payload: arubaAccessPoints,
    };
  },

  normalise(raw): Signal[] {
    const body = raw.payload as typeof arubaAccessPoints;
    const observedAt = raw.fetchedAt;

    return body.aps.map((ap) => {
      // A down AP has no CPU reading at all - absence of data is itself the
      // signal. Mapping "Down" to health 0 keeps it comparable with the rest.
      const health = ap.status === 'Up' ? Math.max(0, 100 - ap.cpu_utilization) : 0;

      return {
        tenantId: raw.tenantId,
        signalId: signalId('aruba-central', ap.serial, observedAt),
        provider: 'aruba-central', domain: 'network', kind: 'device-health',
        siteId: ap.site, sourceRef: ap.serial,
        value: health, unit: 'percent',
        severity: severityFor('device-health', health),
        observedAt,
        attributes: {
          apName: ap.name, arubaStatus: ap.status,
          radioUtilisation: ap.radios[0]?.utilization ?? 0,
        },
      } satisfies Signal;
    });
  },
};
