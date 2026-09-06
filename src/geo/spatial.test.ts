/**
 * Geospatial tests. The lon/lat ordering test is the one that earns its keep:
 * a swap does not throw, it silently returns a wrong answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { haversineKm, bboxAround, inBBox, pointInPolygon, centroid } from './spatial.ts';
import { encode, decodePoint, compressionRatio } from './topojson.ts';
import { sitesToFeatureCollection, computeBBox, polygon } from './geojson.ts';
import { sitesWithinRadius, regionContaining } from './site-repository.ts';
import { US_SOUTH_REGION } from '../data/sites.ts';
import { verifyToken, signDemoToken } from '../auth/cognito-jwt-verifier.ts';

const principal = verifyToken(signDemoToken({
  sub: 'u1', 'custom:tenantId': 'acme', 'cognito:groups': ['operator'],
}));

const DALLAS = { lon: -96.7970, lat: 32.7767 };
const AUSTIN = { lon: -97.7431, lat: 30.2672 };

test('haversine matches the known Dallas-Austin distance', () => {
  const km = haversineKm(DALLAS, AUSTIN);
  assert.ok(km > 285 && km < 300, 'expected ~293km, got ' + km);
});

test('swapping lon and lat produces a completely different answer', () => {
  const correct = haversineKm(DALLAS, AUSTIN);
  const swapped = haversineKm(
    { lon: DALLAS.lat, lat: DALLAS.lon },
    { lon: AUSTIN.lat, lat: AUSTIN.lon },
  );
  // Not a rounding difference - a different continent. This is why the REST
  // handler range-checks coordinates instead of trusting the caller.
  assert.ok(Math.abs(correct - swapped) > 100);
});

test('the bbox pre-filter never excludes a point that is genuinely in range', () => {
  // The bbox must be a SUPERSET of the circle, or phase 1 of the two-phase
  // spatial query would drop valid results before phase 2 ever sees them.
  const radiusKm = 300;
  const box = bboxAround(DALLAS, radiusKm);

  assert.ok(inBBox(AUSTIN, box), 'Austin is 293km away and must survive the bbox');
  assert.ok(haversineKm(DALLAS, AUSTIN) < radiusKm);
});

test('sitesWithinRadius returns results sorted by distance', () => {
  const near = sitesWithinRadius(principal, DALLAS, 1200);
  const distances = near.map((s) => s.distanceKm);

  assert.ok(near.length > 1);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  assert.equal(near[0].siteId, 'dal-01'); // itself, at 0km
});

test('point-in-polygon puts only the southern sites in the us-south region', () => {
  assert.ok(pointInPolygon(DALLAS, US_SOUTH_REGION));
  assert.ok(pointInPolygon(AUSTIN, US_SOUTH_REGION));
  assert.ok(!pointInPolygon({ lon: -87.6298, lat: 41.8781 }, US_SOUTH_REGION)); // Chicago
  assert.equal(regionContaining(DALLAS), 'us-south');
  assert.equal(regionContaining({ lon: -87.6298, lat: 41.8781 }), undefined);
});

test('polygon() closes an unclosed ring, as RFC 7946 requires', () => {
  const open = [[0, 0], [1, 0], [1, 1]] as Array<[number, number]>;
  const geom = polygon(open);
  const ring = (geom as { coordinates: Array<Array<[number, number]>> }).coordinates[0];

  assert.equal(ring.length, 4);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

test('centroid of two points is their midpoint', () => {
  const mid = centroid([DALLAS, AUSTIN]);
  assert.ok(Math.abs(mid.lon - (DALLAS.lon + AUSTIN.lon) / 2) < 1e-9);
});

test('TopoJSON round-trips within the quantisation error, and shrinks polygons', () => {
  const fc = sitesToFeatureCollection(
    [{ tenantId: 'acme', siteId: 'dal-01', name: 'Dallas', region: 'us-south', ...DALLAS, headcount: 10 }],
    new Map(),
  );
  const topo = encode(fc);
  const [lon, lat] = decodePoint(topo, topo.objects.sites.geometries[0]);

  // Lossy by design: quantisation trades sub-metre precision for bytes.
  assert.ok(Math.abs(lon - DALLAS.lon) < 0.01);
  assert.ok(Math.abs(lat - DALLAS.lat) < 0.01);

  // A detailed polygon is where the format actually pays.
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < 400; i++) {
    const a = (i / 400) * Math.PI * 2;
    ring.push([-98.5 + Math.cos(a) * 6.482913746192, 32 + Math.sin(a) * 4.117482910473]);
  }
  ring.push(ring[0]);

  const detailed = {
    type: 'FeatureCollection' as const,
    features: [{ type: 'Feature' as const, geometry: polygon(ring), properties: {} }],
    bbox: computeBBox([{ type: 'Feature', geometry: polygon(ring), properties: {} }]),
  };

  assert.ok(compressionRatio(detailed, encode(detailed)) > 0.5);
});

test('FeatureCollection properties carry what MapBox styles read', () => {
  const fc = sitesToFeatureCollection(
    [{ tenantId: 'acme', siteId: 'dal-01', name: 'Dallas', region: 'us-south', ...DALLAS, headcount: 1200 }],
    new Map([['dal-01', [{
      tenantId: 'acme', signalId: 's1', provider: 'splunk', domain: 'observability',
      kind: 'error-rate', siteId: 'dal-01', sourceRef: 'x', value: 9, unit: 'percent',
      severity: 'critical', observedAt: '2026-09-04T10:00:00Z', attributes: {},
    }]]]),
  );

  const props = fc.features[0].properties as { severity: string; impactScore: number };
  assert.equal(props.severity, 'critical'); // drives circle-color
  assert.ok(props.impactScore > 0);         // drives circle-radius
  assert.deepEqual(fc.features[0].geometry, { type: 'Point', coordinates: [DALLAS.lon, DALLAS.lat] });
});
