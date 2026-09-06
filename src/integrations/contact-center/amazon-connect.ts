/**
 * Amazon Connect - the one integration with NO secret to manage.
 *
 * Auth:  AWS SigV4 via the Lambda's own execution role. No API key, no OAuth,
 *        no rotation, no Secrets Manager call on the hot path. When you get to
 *        choose the vendor, this is a real operational argument for Connect.
 *
 * Real call:
 *   import { ConnectClient, GetCurrentMetricDataCommand } from '@aws-sdk/client-connect';
 *   await new ConnectClient({}).send(new GetCurrentMetricDataCommand({
 *     InstanceId, Filters: { Queues: [...], Channels: ['VOICE'] },
 *     CurrentMetrics: [
 *       { Name: 'CONTACTS_IN_QUEUE',  Unit: 'COUNT' },
 *       { Name: 'OLDEST_CONTACT_AGE', Unit: 'SECONDS' },
 *     ],
 *   }));
 *
 * IAM policy needed: connect:GetCurrentMetricData on the instance ARN. Scope it
 * to the instance, never "*".
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Signal } from '../../platform/types.ts';
import { signalId } from '../../platform/ids.ts';
import { connectCurrentMetrics, maybeFail } from '../fixtures.ts';

export const amazonConnect: Connector = {
  provider: 'amazon-connect',
  domain: 'contact-center',
  auth: 'aws-sigv4',
  rateLimitPerMin: 120,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('amazon-connect');
    return {
      tenantId: ctx.tenantId,
      provider: 'amazon-connect',
      fetchedAt: new Date().toISOString(),
      payload: connectCurrentMetrics,
    };
  },

  normalise(raw): Signal[] {
    const body = raw.payload as typeof connectCurrentMetrics;
    const observedAt = body.DataSnapshotTime;

    return body.MetricResults.map((result) => {
      // Connect's queue ids are already our site ids by convention: "q-den-01".
      const queueId = result.Dimensions.Queue.Id;
      const siteId = queueId.replace(/^q-/, '');

      const byName = new Map(result.Collections.map((c) => [c.Metric.Name, c.Value]));
      const oldest = byName.get('OLDEST_CONTACT_AGE') ?? 0;

      return {
        tenantId: raw.tenantId,
        signalId: signalId('amazon-connect', queueId, observedAt),
        provider: 'amazon-connect', domain: 'contact-center', kind: 'queue-wait',
        siteId, sourceRef: queueId,
        value: oldest, unit: 'seconds',
        severity: severityFor('queue-wait', oldest),
        observedAt,
        attributes: {
          contactsInQueue: byName.get('CONTACTS_IN_QUEUE') ?? 0,
          agentsAvailable: byName.get('AGENTS_AVAILABLE') ?? 0,
        },
      } satisfies Signal;
    });
  },
};
