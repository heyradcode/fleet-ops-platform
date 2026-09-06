/**
 * The tests that matter most on an integration project: given ONE vendor
 * response, does normalise() produce the Telemetry we expect?
 *
 * These are the tests that catch the day a vendor renames a field - which they
 * will do, without telling you.
 *
 * The unit conversions get their own assertions on purpose. A wrong factor of
 * 60 in an hours-of-service reading does not throw, does not fail a type check,
 * and silently disables every safety warning in the platform.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { samsara } from './telematics/samsara.ts';
import { geotab } from './telematics/geotab.ts';
import { verizonConnect } from './telematics/verizon-connect.ts';
import { motive } from './eld-hos/motive.ts';
import { omnitracs } from './eld-hos/omnitracs.ts';
import { lytx } from './video-safety/lytx.ts';
import { netradyne } from './video-safety/netradyne.ts';
import { severityFor, withRetry, CircuitBreaker, ProviderError } from './connector.ts';
import { connectors, connectorsFor, providersFor } from './registry.ts';
import { verifyToken, signDemoToken } from '../auth/cognito-jwt-verifier.ts';
import {
  samsaraVehicleStats, geotabDeviceStatusInfo, verizonConnectVehicles,
  motiveHosLogs, omnitracsHos, lytxEvents, netradyneAlerts,
} from './fixtures.ts';

const ctx = { tenantId: 'acme-freight', secrets: {}, since: new Date(0) };
const T = '2026-09-08T14:30:00.000Z';

test('samsara: one vehicle row yields separate position and braking readings', () => {
  const readings = samsara.normalise({
    tenantId: 'acme-freight', provider: 'samsara', fetchedAt: T,
    payload: samsaraVehicleStats,
  });

  // Two vehicles, both with GPS; only one has a harsh event.
  assert.equal(readings.filter((t) => t.kind === 'position').length, 2);
  assert.equal(readings.filter((t) => t.kind === 'harsh-brake').length, 1);

  const brake = readings.find((t) => t.kind === 'harsh-brake');
  assert.ok(brake);
  assert.equal(brake.driverId, 'drv-0142');
  assert.equal(brake.severity, 'critical'); // 0.62g, threshold is 0.55
});

test('samsara: miles per hour are converted to km/h', () => {
  const readings = samsara.normalise({
    tenantId: 'acme-freight', provider: 'samsara', fetchedAt: T,
    payload: samsaraVehicleStats,
  });

  const moving = readings.find((t) => t.kind === 'position' && t.value > 0);
  assert.ok(moving);
  // 41.6 mph is ~66.9 km/h. If this ever reads 41.6 the conversion was dropped
  // and every speed in the platform is understated by 38%.
  assert.ok(moving.value > 66 && moving.value < 68, 'expected ~66.9 kph, got ' + moving.value);
  assert.equal(moving.unit, 'kph');
});

test('geotab: already-metric speed is passed through unconverted', () => {
  const readings = geotab.normalise({
    tenantId: 'acme-freight', provider: 'geotab', fetchedAt: T,
    payload: geotabDeviceStatusInfo,
  });

  assert.equal(readings[0].value, 88);   // NOT converted - Geotab is metric
  assert.equal(readings[0].unit, 'kph');
  assert.equal(readings[0].driverId, 'drv-0311');
});

test('verizon: a speeding reading only appears when over the posted limit', () => {
  const readings = verizonConnect.normalise({
    tenantId: 'acme-freight', provider: 'verizon-connect', fetchedAt: T,
    payload: verizonConnectVehicles,
  });

  const speeding = readings.find((t) => t.kind === 'speeding');
  assert.ok(speeding);
  assert.equal(speeding.value, 12);      // 52 observed - 40 posted
  assert.equal(speeding.severity, 'warning');
});

test('motive: hours-of-service SECONDS become canonical MINUTES', () => {
  const readings = motive.normalise({
    tenantId: 'acme-freight', provider: 'motive', fetchedAt: T,
    payload: motiveHosLogs,
  });

  const low = readings.find((t) => t.driverId === 'drv-0142');
  assert.ok(low);
  // 2040 seconds -> 34 minutes. Reading it as 2040 minutes would put this
  // driver comfortably inside every threshold and silence the warning.
  assert.equal(low.value, 34);
  assert.equal(low.unit, 'minutes');
  assert.equal(low.severity, 'critical'); // <= 40 minutes left
});

test('omnitracs: already-minutes hours-of-service is passed through', () => {
  const readings = omnitracs.normalise({
    tenantId: 'acme-freight', provider: 'omnitracs', fetchedAt: T,
    payload: omnitracsHos,
  });

  assert.equal(readings[0].value, 45);   // NOT divided by 60
  assert.equal(readings[0].unit, 'minutes');
  assert.equal(readings[0].severity, 'warning');
});

test('hos-remaining severity is INVERTED - fewer minutes is worse', () => {
  assert.equal(severityFor('hos-remaining', 300), 'ok');
  assert.equal(severityFor('hos-remaining', 50), 'warning');
  assert.equal(severityFor('hos-remaining', 20), 'critical');

  // And the normal direction still works.
  assert.equal(severityFor('harsh-brake', 0.1), 'ok');
  assert.equal(severityFor('harsh-brake', 0.6), 'critical');
});

test('netradyne: epoch millis become ISO-8601', () => {
  const readings = netradyne.normalise({
    tenantId: 'acme-freight', provider: 'netradyne', fetchedAt: T,
    payload: netradyneAlerts,
  });

  assert.equal(readings[0].observedAt, '2026-09-08T14:29:00.000Z');
  assert.equal(readings[0].value, 23);   // 1380 seconds idling -> 23 minutes
  assert.equal(readings[0].kind, 'idle');
});

test('samsara and lytx independently witness the SAME braking event', () => {
  // This is the property the whole corroboration rule rests on: two different
  // vendors, two different devices, one physical event on one truck.
  const fromSamsara = samsara.normalise({
    tenantId: 'acme-freight', provider: 'samsara', fetchedAt: T, payload: samsaraVehicleStats,
  }).find((t) => t.kind === 'harsh-brake');

  const fromLytx = lytx.normalise({
    tenantId: 'acme-freight', provider: 'lytx', fetchedAt: T, payload: lytxEvents,
  }).find((t) => t.kind === 'harsh-brake');

  assert.ok(fromSamsara && fromLytx);
  assert.equal(fromSamsara.driverId, fromLytx.driverId);
  assert.equal(fromSamsara.observedAt, fromLytx.observedAt);
  // Different vendors, so different ids - they are two witnesses, not a
  // duplicate. detectIncidents counts DISTINCT providers for exactly this.
  assert.notEqual(fromSamsara.provider, fromLytx.provider);
  assert.notEqual(fromSamsara.telemetryId, fromLytx.telemetryId);
});

test('telemetryId is a content hash, so re-ingesting the same reading is idempotent', async () => {
  const raw = await samsara.fetchRaw(ctx);
  const first = samsara.normalise({ ...raw, fetchedAt: '2026-09-08T14:30:00.000Z' });
  const second = samsara.normalise({ ...raw, fetchedAt: '2026-09-08T14:35:00.000Z' });

  // Different fetch times, same observation -> same ids. A duplicate delivery
  // overwrites rather than duplicating.
  assert.deepEqual(
    first.map((t) => t.telemetryId),
    second.map((t) => t.telemetryId),
  );
});

test('every registered connector declares a rate limit and a domain', () => {
  for (const c of connectors) {
    assert.ok(c.rateLimitPerMin > 0, c.provider + ' must declare a rate limit');
    assert.ok(['telematics', 'eld-hos', 'video-safety'].includes(c.domain));
  }
  assert.equal(connectors.length, 8);
});

test('a tenant polls only the vendors it actually runs', () => {
  const acme = verifyToken(signDemoToken({
    sub: 'u1', 'custom:tenantId': 'acme-freight', 'cognito:groups': ['dispatcher'],
  }));

  const active = connectorsFor(acme).map((c) => c.provider);
  assert.deepEqual(active.sort(), ['lytx', 'motive', 'samsara']);

  // A carrier running one GPS unit, one ELD and one dashcam per truck is the
  // realistic case; polling all eight would not be.
  assert.equal(active.length, 3);
  assert.notDeepEqual(providersFor('acme-freight'), providersFor('northstar-logistics'));
});

test('withRetry retries a 503 but never retries a 401', async () => {
  let attempts = 0;
  const ok = await withRetry('t', async () => {
    attempts++;
    if (attempts < 3) throw new ProviderError('samsara', 503, 'unavailable');
    return 'done';
  }, { baseMs: 1 });

  assert.equal(ok, 'done');
  assert.equal(attempts, 3);

  let authAttempts = 0;
  await assert.rejects(
    withRetry('t', async () => {
      authAttempts++;
      throw new ProviderError('samsara', 401, 'bad token');
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
