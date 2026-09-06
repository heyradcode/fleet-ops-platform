/**
 * ThousandEyes - synthetic network tests from vantage points ("agents").
 *
 * Auth:  Bearer OAuth token.
 * Why it matters: Meraki tells you what YOUR device thinks. ThousandEyes tells
 * you what the internet path between a city and a SaaS app actually looks like.
 * When Meraki says "fine" and ThousandEyes says "6% loss", the problem is the
 * carrier, not you - and that correlation is exactly what the agent is for.
 *
 * Real call: GET https://api.thousandeyes.com/v7/test-results/{testId}/network
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Signal } from '../../platform/types.ts';
import { signalId } from '../../platform/ids.ts';
import { thousandEyesNetworkResults, maybeFail } from '../fixtures.ts';

const AGENT_TO_SITE: Record<string, string> = { 'a-dal': 'dal-01', 'a-aus': 'aus-01' };

export const thousandEyes: Connector = {
  provider: 'thousandeyes',
  domain: 'observability',
  auth: 'bearer-token',
  rateLimitPerMin: 240,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('thousandeyes');
    return {
      tenantId: ctx.tenantId,
      provider: 'thousandeyes',
      fetchedAt: new Date().toISOString(),
      payload: thousandEyesNetworkResults,
    };
  },

  normalise(raw): Signal[] {
    const body = raw.payload as typeof thousandEyesNetworkResults;
    const signals: Signal[] = [];

    for (const r of body.results) {
      const siteId = AGENT_TO_SITE[r.agentId] ?? 'unknown';

      signals.push({
        tenantId: raw.tenantId,
        signalId: signalId('thousandeyes', r.testId + ':loss', r.date),
        provider: 'thousandeyes', domain: 'observability', kind: 'packet-loss',
        siteId, sourceRef: r.testId,
        value: r.loss, unit: 'percent',
        severity: severityFor('packet-loss', r.loss),
        observedAt: r.date,
        attributes: { testName: r.testName, agent: r.agentName, jitterMs: r.jitter },
      });

      signals.push({
        tenantId: raw.tenantId,
        signalId: signalId('thousandeyes', r.testId + ':latency', r.date),
        provider: 'thousandeyes', domain: 'observability', kind: 'wan-latency',
        siteId, sourceRef: r.testId,
        value: r.avgLatency, unit: 'ms',
        severity: severityFor('wan-latency', r.avgLatency),
        observedAt: r.date,
        attributes: { testName: r.testName, agent: r.agentName, jitterMs: r.jitter },
      });
    }
    return signals;
  },
};
