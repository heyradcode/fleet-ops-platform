/**
 * Metric severity, pinned - in particular the INVERTED metrics, where a
 * smaller number is worse and a threshold written the ordinary way round is
 * wrong without anything failing.
 *
 * This file exists because reachability was [1, 1] for a release: every
 * reachable device came out `critical`. The alarm rules test `value === 0`
 * directly, so no alarm changed and no test failed - while the map painted
 * healthy devices red and the agent was handed "CRITICAL reachability 1" as
 * evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { severityForMetric, UTILISATION_THRESHOLDS } from './classify.ts';

test('reachability: 1 is ok, 0 is critical - never the other way', () => {
  assert.equal(severityForMetric('reachability', 1), 'ok');
  assert.equal(severityForMetric('reachability', 0), 'critical');
});

test('optical rx power: more negative is worse', () => {
  assert.equal(severityForMetric('optical-rx-power', -5), 'ok');
  assert.equal(severityForMetric('optical-rx-power', -15), 'warning');
  assert.equal(severityForMetric('optical-rx-power', -20), 'critical');
});

test('ordinary metrics: larger is worse, at the shared utilisation thresholds', () => {
  assert.equal(severityForMetric('cpu-utilisation', UTILISATION_THRESHOLDS.warning - 1), 'ok');
  assert.equal(severityForMetric('cpu-utilisation', UTILISATION_THRESHOLDS.warning), 'warning');
  assert.equal(severityForMetric('cpu-utilisation', UTILISATION_THRESHOLDS.critical), 'critical');
});
