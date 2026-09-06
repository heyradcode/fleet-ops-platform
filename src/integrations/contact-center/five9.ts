/**
 * Five9 - Statistics / Supervisor API.
 *
 * Auth:  HTTP Basic. The classic Five9 surface is SOAP+XML; newer endpoints are
 *        JSON. Either way you get flat rows, which is a pleasant change.
 * Trap:  Five9 identifies queues by NAME, not id, and names contain the site as
 *        a prefix. So the site mapping is string parsing - brittle, and worth
 *        an explicit fallback rather than a crash.
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Signal } from '../../platform/types.ts';
import { signalId } from '../../platform/ids.ts';
import { five9QueueStats, maybeFail } from '../fixtures.ts';

const CITY_TO_SITE: Record<string, string> = {
  dallas: 'dal-01', austin: 'aus-01', denver: 'den-01',
  chicago: 'chi-01', phoenix: 'phx-01',
};

function siteFromQueueName(queueName: string): string {
  const city = queueName.split('_')[0]?.toLowerCase() ?? '';
  return CITY_TO_SITE[city] ?? 'unknown';
}

export const five9: Connector = {
  provider: 'five9',
  domain: 'contact-center',
  auth: 'basic',
  rateLimitPerMin: 60,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('five9');
    return {
      tenantId: ctx.tenantId,
      provider: 'five9',
      fetchedAt: new Date().toISOString(),
      payload: five9QueueStats,
    };
  },

  normalise(raw): Signal[] {
    const body = raw.payload as typeof five9QueueStats;
    const observedAt = body.asOf;
    const signals: Signal[] = [];

    for (const q of body.queues) {
      const siteId = siteFromQueueName(q.queueName);

      signals.push({
        tenantId: raw.tenantId,
        signalId: signalId('five9', q.queueName + ':wait', observedAt),
        provider: 'five9', domain: 'contact-center', kind: 'queue-wait',
        siteId, sourceRef: q.queueName,
        value: q.longestWaitSeconds, unit: 'seconds',
        severity: severityFor('queue-wait', q.longestWaitSeconds),
        observedAt,
        attributes: { callsInQueue: q.callsInQueue, agentsReady: q.agentsReady },
      });

      signals.push({
        tenantId: raw.tenantId,
        signalId: signalId('five9', q.queueName + ':abandon', observedAt),
        provider: 'five9', domain: 'contact-center', kind: 'abandon-rate',
        siteId, sourceRef: q.queueName,
        value: q.abandonRatePercent, unit: 'percent',
        severity: severityFor('abandon-rate', q.abandonRatePercent),
        observedAt,
        attributes: { callsInQueue: q.callsInQueue, agentsReady: q.agentsReady },
      });
    }
    return signals;
  },
};
