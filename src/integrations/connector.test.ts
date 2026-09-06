/**
 * The tests that matter most on an integration project: given ONE captured
 * vendor response, does normalise() produce the Signal we expect?
 *
 * These are the tests that catch the day a vendor renames a field - which they
 * will do, without telling you.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ciscoMeraki } from './network/cisco-meraki.ts';
import { juniperMist } from './network/juniper-mist.ts';
import { five9 } from './contact-center/five9.ts';
import { splunk } from './observability/splunk.ts';
import { severityFor, withRetry, CircuitBreaker, ProviderError } from './connector.ts';
import { connectors } from './registry.ts';
import { merakiDeviceStatuses, mistDeviceStats, five9QueueStats, splunkSearchResults } from './fixtures.ts';

const ctx = { tenantId: 'acme', secrets: {}, since: new Date(0) };

test('meraki: one device row yields separate latency and loss signals', () => {
  const signals = ciscoMeraki.normalise({
    tenantId: 'acme', provider: 'cisco-meraki',
    fetchedAt: '2026-09-04T10:00:00Z', payload: merakiDeviceStatuses,
  });

  assert.equal(signals.length, merakiDeviceStatuses.items.length * 2);

  const dallasLoss = signals.find((s) => s.siteId === 'dal-01' && s.kind === 'packet-loss');
  assert.ok(dallasLoss);
  assert.equal(dallasLoss.value, 7.4);
  assert.equal(dallasLoss.severity, 'critical'); // 7.4% loss, threshold is 5
});

test('mist: unix seconds become ISO, and CPU util is inverted into health', () => {
  const signals = juniperMist.normalise({
    tenantId: 'acme', provider: 'juniper-mist',
    fetchedAt: '2026-09-04T10:00:00Z', payload: mistDeviceStats,
  });

  const dallas = signals.find((s) => s.siteId === 'dal-01');
  assert.ok(dallas);
  // cpu_util 91 -> health 9 -> critical, because health is inverted.
  assert.equal(dallas.value, 9);
  assert.equal(dallas.severity, 'critical');
  assert.equal(dallas.observedAt, new Date(1_788_000_000 * 1000).toISOString());
});

test('five9: site is parsed out of the queue name, unknown falls back safely', () => {
  const signals = five9.normalise({
    tenantId: 'acme', provider: 'five9',
    fetchedAt: '2026-09-04T10:00:00Z', payload: five9QueueStats,
  });

  assert.equal(signals.find((s) => s.sourceRef === 'Dallas_Support')?.siteId, 'dal-01');
  assert.equal(signals.find((s) => s.sourceRef === 'Austin_Billing')?.siteId, 'aus-01');
});

test('splunk: string numbers are parsed, and a NaN row is dropped not propagated', () => {
  const poisoned = {
    ...splunkSearchResults,
    results: [...splunkSearchResults.results, { site: 'bad-01', error_rate: 'n/a', events: 'x', _time: '2026-09-04T09:55:00Z' }],
  };

  const signals = splunk.normalise({
    tenantId: 'acme', provider: 'splunk', fetchedAt: '2026-09-04T10:00:00Z', payload: poisoned,
  });

  assert.equal(signals.length, 2); // the unparseable row was skipped
  assert.ok(signals.every((s) => Number.isFinite(s.value)));
});

test('signalId is a content hash, so re-ingesting the same reading is idempotent', async () => {
  const raw = await ciscoMeraki.fetchRaw(ctx);
  const first = ciscoMeraki.normalise({ ...raw, fetchedAt: '2026-09-04T10:00:00Z' });
  const second = ciscoMeraki.normalise({ ...raw, fetchedAt: '2026-09-04T10:05:00Z' });

  // Different fetch times, same observation -> same ids. A duplicate delivery
  // overwrites rather than duplicating.
  assert.deepEqual(first.map((s) => s.signalId), second.map((s) => s.signalId));
});

test('severity thresholds invert correctly for device-health', () => {
  assert.equal(severityFor('packet-loss', 0.2), 'ok');
  assert.equal(severityFor('packet-loss', 6), 'critical');

  // Health is inverted: LOWER is worse.
  assert.equal(severityFor('device-health', 99), 'ok');
  assert.equal(severityFor('device-health', 70), 'critical');
});

test('every registered connector declares a rate limit and a domain', () => {
  for (const c of connectors) {
    assert.ok(c.rateLimitPerMin > 0, c.provider + ' must declare a rate limit');
    assert.ok(['network', 'contact-center', 'observability'].includes(c.domain));
  }
});

test('withRetry retries a 503 but never retries a 401', async () => {
  let attempts = 0;
  const ok = await withRetry('t', async () => {
    attempts++;
    if (attempts < 3) throw new ProviderError('splunk', 503, 'unavailable');
    return 'done';
  }, { baseMs: 1 });

  assert.equal(ok, 'done');
  assert.equal(attempts, 3);

  let authAttempts = 0;
  await assert.rejects(
    withRetry('t', async () => {
      authAttempts++;
      throw new ProviderError('splunk', 401, 'bad token');
    }, { baseMs: 1 }),
  );
  assert.equal(authAttempts, 1); // a bad credential will not fix itself
});

test('circuit breaker opens after the threshold and stops calling the vendor', async () => {
  const breaker = new CircuitBreaker('test', 3, 10_000);
  const boom = async () => { throw new Error('vendor down'); };

  for (let i = 0; i < 3; i++) {
    await assert.rejects(breaker.run(boom));
  }
  assert.equal(breaker.state, 'open');

  // Now it fails WITHOUT calling the vendor at all.
  let called = false;
  await assert.rejects(breaker.run(async () => { called = true; return 1; }));
  assert.equal(called, false);
});
