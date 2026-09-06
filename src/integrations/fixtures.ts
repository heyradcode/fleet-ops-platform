/**
 * Canned vendor responses, shaped like the real APIs.
 *
 * These stand in for the HTTP calls so the demo runs offline. They are also
 * how you would unit-test `normalise()` for real: capture one true response per
 * vendor, commit it, and assert the Signal it produces. That test catches the
 * day the vendor renames a field - which they will, without telling you.
 *
 * Notice how different the eight shapes are. That difference is the entire
 * justification for the normalisation layer.
 */

/** Cisco Meraki - GET /organizations/{id}/devices/statuses */
export const merakiDeviceStatuses = {
  items: [
    { serial: 'Q2XX-AAAA-1111', name: 'DAL-MX250-WAN', networkId: 'N_dal_01', status: 'alerting', lossPercent: 7.4, latencyMs: 310, lastReportedAt: '2026-09-04T09:58:00Z' },
    { serial: 'Q2XX-BBBB-2222', name: 'AUS-MS350-CORE', networkId: 'N_aus_01', status: 'online', lossPercent: 0.1, latencyMs: 22, lastReportedAt: '2026-09-04T09:58:00Z' },
    { serial: 'Q2XX-CCCC-3333', name: 'DEN-MR46-AP07', networkId: 'N_den_01', status: 'online', lossPercent: 0.6, latencyMs: 41, lastReportedAt: '2026-09-04T09:57:00Z' },
  ],
  meta: { counts: { items: { remaining: 0 } } },
};

/** Juniper Mist - GET /api/v1/sites/{site_id}/stats/devices */
export const mistDeviceStats = {
  results: [
    { mac: '5c5b350e1111', name: 'dal-ex4400-01', site_id: 'dal-01', status: 'up', cpu_util: 91, mem_util: 78, uptime: 8_640_000, last_seen: 1_788_000_000 },
    { mac: '5c5b350e2222', name: 'chi-ex4400-01', site_id: 'chi-01', status: 'up', cpu_util: 34, mem_util: 51, uptime: 12_960_000, last_seen: 1_788_000_060 },
  ],
  total: 2,
};

/** HPE Aruba Central - GET /monitoring/v2/aps */
export const arubaAccessPoints = {
  aps: [
    { serial: 'CNXXX1111', name: 'PHX-AP-201', site: 'phx-01', status: 'Down', cpu_utilization: 0, uptime: 0, radios: [{ band: '5GHz', utilization: 0 }] },
    { serial: 'CNXXX2222', name: 'AUS-AP-114', site: 'aus-01', status: 'Up', cpu_utilization: 22, uptime: 604_800, radios: [{ band: '5GHz', utilization: 63 }] },
  ],
  count: 2,
};

/** Genesys Cloud - POST /api/v2/analytics/queues/observations/query */
export const genesysQueueObservations = {
  results: [
    {
      group: { queueId: 'q-dallas-support', mediaType: 'voice' },
      data: [
        { metric: 'oWaiting', stats: { count: 47 } },
        { metric: 'oOldestWaiting', stats: { max: 214 } },   // seconds
        { metric: 'oInteracting', stats: { count: 18 } },
      ],
    },
  ],
};

/** Five9 - Statistics API (SOAP originally; REST-ish JSON here) */
export const five9QueueStats = {
  queues: [
    { queueName: 'Austin_Billing', callsInQueue: 3, longestWaitSeconds: 41, abandonRatePercent: 2.1, agentsReady: 12 },
    { queueName: 'Dallas_Support', callsInQueue: 47, longestWaitSeconds: 214, abandonRatePercent: 14.8, agentsReady: 2 },
  ],
  asOf: '2026-09-04T10:00:00Z',
};

/** Amazon Connect - GetCurrentMetricData (real AWS SDK response shape) */
export const connectCurrentMetrics = {
  MetricResults: [
    {
      Dimensions: { Queue: { Id: 'q-den-01', Arn: 'arn:aws:connect:us-east-1:1111:instance/abc/queue/q-den-01' } },
      Collections: [
        { Metric: { Name: 'CONTACTS_IN_QUEUE', Unit: 'COUNT' }, Value: 6 },
        { Metric: { Name: 'OLDEST_CONTACT_AGE', Unit: 'SECONDS' }, Value: 73 },
        { Metric: { Name: 'AGENTS_AVAILABLE', Unit: 'COUNT' }, Value: 9 },
      ],
    },
  ],
  DataSnapshotTime: '2026-09-04T10:00:00Z',
};

/** ThousandEyes - GET /v7/test-results/{testId}/network */
export const thousandEyesNetworkResults = {
  results: [
    { testId: 't-9001', testName: 'DAL -> SaaS App', agentId: 'a-dal', agentName: 'Dallas', loss: 6.2, avgLatency: 288, jitter: 31, date: '2026-09-04T09:59:00Z' },
    { testId: 't-9002', testName: 'AUS -> SaaS App', agentId: 'a-aus', agentName: 'Austin', loss: 0.0, avgLatency: 24, jitter: 2, date: '2026-09-04T09:59:00Z' },
  ],
};

/** Splunk - POST /services/search/jobs/export (statistical search output) */
export const splunkSearchResults = {
  fields: [{ name: 'site' }, { name: 'error_rate' }, { name: 'events' }, { name: '_time' }],
  results: [
    { site: 'dal-01', error_rate: '8.10', events: '41200', _time: '2026-09-04T09:55:00Z' },
    { site: 'chi-01', error_rate: '0.42', events: '9800', _time: '2026-09-04T09:55:00Z' },
  ],
};

/**
 * Provider-side failure injection. `demo.ts` flips this on to show the retry
 * policy, the circuit breaker and the Step Functions Catch all doing their job.
 */
export const chaos = { failuresRemaining: 0 };

export function maybeFail(provider: string): void {
  if (chaos.failuresRemaining > 0) {
    chaos.failuresRemaining--;
    const err = new Error('upstream 503 from ' + provider);
    (err as Error & { status?: number }).status = 503;
    throw err;
  }
}
