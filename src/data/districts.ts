/**
 * Seed data: five dispatch districts, their boundaries, and a starter fleet.
 *
 * In production these live in Aurora PostgreSQL with PostGIS (see
 * src/data/schema.sql) and are cached into DynamoDB for the hot read path.
 *
 * The FLEET is not here - it is generated from a seed in generate.ts, because
 * a readable generator shows what a fleet looks like where a list of literals
 * just rots. Districts are static reference data, so they stay.
 *
 * All of it is synthetic. Real driver telemetry is a location trace of an
 * identifiable person and has no business in a demo repository.
 */
import type { Territory } from '../platform/types.ts';
import type { Position } from '../geo/spatial.ts';

/** The five districts, keyed on the depot each one dispatches from. */
export const DISTRICTS: Omit<Territory, 'tenantId'>[] = [
  { districtId: 'dal', name: 'Dallas',  region: 'us-south',   lon: -96.7970,  lat: 32.7767 },
  { districtId: 'aus', name: 'Austin',  region: 'us-south',   lon: -97.7431,  lat: 30.2672 },
  { districtId: 'den', name: 'Denver',  region: 'us-west',    lon: -104.9903, lat: 39.7392 },
  { districtId: 'chi', name: 'Chicago', region: 'us-central', lon: -87.6298,  lat: 41.8781 },
  { districtId: 'phx', name: 'Phoenix', region: 'us-west',    lon: -112.0740, lat: 33.4484 },
];

/**
 * The "US South" service region, as a GeoJSON linear ring.
 * Remember: [lon, lat], and the ring must be closed (last == first).
 * Dallas and Austin fall inside; Denver, Chicago and Phoenix do not.
 */
export const US_SOUTH_REGION: Position[] = [
  [-106.0, 25.5],
  [-93.0, 25.5],
  [-93.0, 36.5],
  [-106.0, 36.5],
  [-106.0, 25.5],
];
