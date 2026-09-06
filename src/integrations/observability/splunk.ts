/**
 * Splunk - search-based, not resource-based.
 *
 * Auth:  Authorization: Splunk <token>  (HEC token, or a session key).
 * Shape: you POST SPL and get rows back. Everything is a STRING, including the
 *        numbers - parseFloat every field or your averages become "0.428.10".
 *
 * Real call:
 *   POST /services/search/jobs/export
 *   search=search index=app earliest=-5m
 *     | stats avg(error_rate) as error_rate, count as events by site
 *   &output_mode=json
 *
 * Cost note: an unbounded `earliest` is how you turn a $200/month Splunk bill
 * into a $20k one. Always window the search, and always pass `since`.
 */
import type { Connector } from '../connector.ts';
import { severityFor } from '../connector.ts';
import type { RawRecord, Signal } from '../../platform/types.ts';
import { signalId } from '../../platform/ids.ts';
import { splunkSearchResults, maybeFail } from '../fixtures.ts';

export const splunk: Connector = {
  provider: 'splunk',
  domain: 'observability',
  auth: 'bearer-token',
  rateLimitPerMin: 60,

  async fetchRaw(ctx): Promise<RawRecord> {
    maybeFail('splunk');
    // The real fetch would interpolate ctx.since into `earliest=`.
    return {
      tenantId: ctx.tenantId,
      provider: 'splunk',
      fetchedAt: new Date().toISOString(),
      payload: splunkSearchResults,
    };
  },

  normalise(raw): Signal[] {
    const body = raw.payload as typeof splunkSearchResults;
    const signals: Signal[] = [];

    for (const row of body.results) {
      // Splunk returns strings. Parse defensively; a NaN here poisons averages
      // downstream and is miserable to trace back.
      const errorRate = Number.parseFloat(row.error_rate);
      const events = Number.parseInt(row.events, 10);
      if (!Number.isFinite(errorRate)) continue;

      signals.push({
        tenantId: raw.tenantId,
        signalId: signalId('splunk', row.site + ':error-rate', row._time),
        provider: 'splunk', domain: 'observability', kind: 'error-rate',
        siteId: row.site, sourceRef: row.site,
        value: errorRate, unit: 'percent',
        severity: severityFor('error-rate', errorRate),
        observedAt: row._time,
        attributes: { events: Number.isFinite(events) ? events : 0, search: 'index=app | stats by site' },
      });
    }
    return signals;
  },
};
