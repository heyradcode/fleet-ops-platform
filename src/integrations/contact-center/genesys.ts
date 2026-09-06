/**
 * Genesys Cloud - Analytics API.
 *
 * Auth:  OAuth2 client-credentials. Token lives ~24h, so cache it in the
 *        Lambda's module scope: warm invocations reuse it for free.
 * Shape: a generic "observation query" - you POST the metrics you want and get
 *        back a nested results/data/stats tree. Flattening it is the whole job.
 *
 * Real call:
 *   POST /api/v2/analytics/queues/observations/query
 *   { filter: { type: 'or', predicates: [{ dimension: 'queueId', value }] },
 *     metrics: ['oWaiting', 'oOldestWaiting', 'oInteracting'] }
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Signal } from '../../platform/types.ts';
import { signalId } from '../../platform/ids.ts';
import { genesysQueueObservations, maybeFail } from '../fixtures.ts';

const QUEUE_TO_SITE: Record<string, string> = {
  'q-dallas-support': 'dal-01', 'q-austin-billing': 'aus-01',
};

export const genesysCloud: Connector = {
  provider: 'genesys-cloud',
  domain: 'contact-center',
  auth: 'oauth2-client-credentials',
  rateLimitPerMin: 300,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('genesys-cloud');
    return {
      tenantId: ctx.tenantId,
      provider: 'genesys-cloud',
      fetchedAt: new Date().toISOString(),
      payload: genesysQueueObservations,
    };
  },

  normalise(raw): Signal[] {
    const body = raw.payload as typeof genesysQueueObservations;
    const observedAt = raw.fetchedAt;
    const signals: Signal[] = [];

    for (const group of body.results) {
      const queueId = group.group.queueId;
      const siteId = QUEUE_TO_SITE[queueId] ?? 'unknown';

      // Flatten the metric/stats tree into a lookup, then pick what we model.
      const metrics = new Map<string, number>();
      for (const d of group.data) {
        metrics.set(d.metric, d.stats.max ?? d.stats.count ?? 0);
      }

      const oldestWait = metrics.get('oOldestWaiting') ?? 0;
      signals.push({
        tenantId: raw.tenantId,
        signalId: signalId('genesys-cloud', queueId + ':wait', observedAt),
        provider: 'genesys-cloud', domain: 'contact-center', kind: 'queue-wait',
        siteId, sourceRef: queueId,
        value: oldestWait, unit: 'seconds',
        severity: severityFor('queue-wait', oldestWait),
        observedAt,
        attributes: {
          mediaType: group.group.mediaType,
          waiting: metrics.get('oWaiting') ?? 0,
          interacting: metrics.get('oInteracting') ?? 0,
        },
      });
    }
    return signals;
  },
};
