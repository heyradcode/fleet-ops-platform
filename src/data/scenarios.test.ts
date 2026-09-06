/**
 * Scenario tests.
 *
 * Each scenario exists to prove one claim about the platform, so each gets an
 * assertion that fails loudly if the claim stops being true. These are the
 * tests that would catch someone "simplifying" the corroboration rule or
 * widening the merge radius back to something that swallows a district.
 *
 * They run the REAL path - vendor payload shapes through normalise, resolve,
 * derive, evaluate, detect - so a regression anywhere in the pipeline surfaces
 * here rather than in a screenshot three weeks later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCENARIOS, scenarioById, type ScenarioId } from './scenarios.ts';
import { generateFleet, generateTrace } from './generate.ts';
import { CORRIDORS, metresFromCorridor, nearestCorridor, pointAlong } from './polylines.ts';
import {
  normaliseAll, resolveTerritory, deriveRouteAdherence, evaluate, detectIncidents,
} from '../pipeline/steps.ts';
import { verifyToken, signDemoToken } from '../auth/cognito-jwt-verifier.ts';
import { setClock, fixedClock } from '../platform/clock.ts';
import type { Principal } from '../platform/types.ts';

setClock(fixedClock());

const dispatcher: Principal = verifyToken(signDemoToken({
  sub: 'u1', 'custom:tenantId': 'acme-freight', 'cognito:groups': ['dispatcher'],
}));

/** Run one scenario end to end and return what the pipeline decided. */
function run(id: ScenarioId) {
  const scenario = scenarioById(id)!;
  const collected = scenario.build('acme-freight').map((raw) => ({ raw }));
  const readings = deriveRouteAdherence(
    resolveTerritory(dispatcher, normaliseAll(dispatcher, collected)),
  );
  const exceptions = evaluate(dispatcher, readings);
  const incidents = detectIncidents(dispatcher, exceptions);
  return { readings, exceptions, incidents };
}

// ---------------------------------------------------------------------------
// The six claims
// ---------------------------------------------------------------------------

test('road-closure: fourteen drivers produce exactly ONE incident', () => {
  const { exceptions, incidents } = run('road-closure');

  // Every affected driver raises both kinds of evidence - off corridor AND
  // stationary - so there is plenty here for the merge to get wrong.
  assert.equal(exceptions.length, 28, 'fourteen drivers x two kinds of evidence');

  assert.equal(incidents.length, 1, 'fourteen pages is how a dispatch board gets ignored');
  assert.equal(incidents[0].driverIds.length, 14);
  assert.equal(incidents[0].districtId, 'dal');
  // Named after the most useful kind, not whichever exception sorted first.
  assert.match(incidents[0].title, /Route deviation affecting 14 drivers/);
});

test('gps-drift: a lone deviation raises an exception but pages NOBODY', () => {
  const { exceptions, incidents } = run('gps-drift');

  // The rules DID notice - this is a candidate, and it is visible on the board.
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].kind, 'route-deviation');

  // ...but nothing corroborates it, so it never becomes a page. This is the
  // most valuable assertion in the suite: anyone can demo a dashboard lighting
  // up. Demonstrating the noise filter working is the hard part, and a
  // dispatcher who has learned to dismiss the board is worse than no board.
  assert.equal(incidents.length, 0);
});

test('harsh-braking: two vendors on one truck agreeing raises an incident', () => {
  const { exceptions, incidents } = run('harsh-braking');

  assert.equal(exceptions.length, 1);
  // The accelerometer and the dashcam are different hardware from different
  // vendors. Two readings from ONE vendor would be one witness, not two.
  assert.deepEqual([...exceptions[0].providers].sort(), ['lytx', 'samsara']);
  assert.equal(incidents.length, 1);
});

test('hos-risk: a regulatory clock escalates without a second opinion', () => {
  const { exceptions, incidents } = run('hos-risk');

  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].kind, 'hos-risk');
  // One ELD per truck, so there is no second device to agree with it. Treating
  // a compliance record as a sensor reading to be double-checked would make
  // hours-of-service warnings permanently undetectable.
  assert.equal(exceptions[0].providers.length, 1);
  assert.equal(incidents.length, 1);
});

test('panic: escalates immediately, on one source', () => {
  const { exceptions, incidents } = run('panic');

  assert.equal(exceptions[0].kind, 'panic');
  assert.equal(exceptions[0].providers.length, 1);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].severity, 'critical');
  assert.match(incidents[0].title, /PANIC ALERT/);
});

test('an hours-of-service risk never merges into a nearby location incident', () => {
  // Two unrelated problems in one district. A driver running out of legal hours
  // beside a road closure needs their own page - merging them would bury it.
  const closure = run('road-closure');
  const hos = run('hos-risk');

  const together = detectIncidents(dispatcher, [...closure.exceptions, ...hos.exceptions]);
  assert.equal(together.length, 2);
  assert.ok(together.some((i) => i.title.includes('Hours-of-service')));
});

// ---------------------------------------------------------------------------
// The generated fleet
// ---------------------------------------------------------------------------

test('the fleet is deterministic - same seed, same sixty drivers', () => {
  assert.deepEqual(generateFleet(), generateFleet());

  const fleet = generateFleet();
  assert.equal(fleet.length, 60);
  assert.equal(new Set(fleet.map((d) => d.driverId)).size, 60, 'ids must be unique');

  // Districts are deliberately uneven - Dallas is the big one, which is what
  // makes the hot-partition argument concrete rather than hypothetical.
  const dal = fleet.filter((d) => d.districtId === 'dal').length;
  const phx = fleet.filter((d) => d.districtId === 'phx').length;
  assert.ok(dal > phx, 'districts must not be uniform');
});

test('the trace is deterministic and drivers stay on their corridors', () => {
  const a = generateTrace({ tenantId: 'acme-freight', ticks: 5 });
  const b = generateTrace({ tenantId: 'acme-freight', ticks: 5 });
  assert.deepEqual(a, b);

  const trace = generateTrace({ tenantId: 'acme-freight', ticks: 60 });
  assert.equal(trace.length, 60);
  assert.equal(trace[0].readings.length, 60);   // one per driver per tick

  // A driving truck must actually be near a road at every tick. A random walk
  // would put it in the Trinity River - invisible at district zoom, and glaring
  // the moment anyone with fleet experience zooms in.
  for (const tick of [trace[0], trace[30], trace[59]]) {
    for (const reading of tick.readings) {
      if (reading.attributes.status !== 'driving') continue;
      const near = nearestCorridor(reading.location!, reading.location!.district);
      assert.ok(near, 'every district must have corridors');
      assert.ok(near.metres < 200, reading.driverId + ' drifted ' + near.metres + 'm off-road');
    }
  }
});

test('a point on a corridor is zero metres from it', () => {
  const corridor = CORRIDORS[0];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const [lon, lat] = pointAlong(corridor, t);
    assert.ok(metresFromCorridor({ lon, lat }, corridor) < 5);
  }

  // ...and a point well off it is not.
  const [lon, lat] = pointAlong(corridor, 0.5);
  assert.ok(metresFromCorridor({ lon: lon - 0.05, lat }, corridor) > 3_000);
});

test('every scenario declares what it proves', () => {
  assert.equal(SCENARIOS.length, 6);
  for (const s of SCENARIOS) {
    assert.ok(s.proves.length > 20, s.id + ' must state its claim');
    assert.ok(s.build('acme-freight').length > 0, s.id + ' must emit payloads');
  }
});
