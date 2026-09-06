/**
 * Seed data: five dispatch districts, their boundaries, and a starter fleet.
 *
 * In production these live in Aurora PostgreSQL with PostGIS (see
 * src/data/schema.sql) and are cached into DynamoDB for the hot read path.
 *
 * THIS IS A PLACEHOLDER SET. Phase 4 of the migration replaces it with a
 * deterministic generator producing ~60 drivers moving along hand-drawn road
 * polylines. What is here is the minimum that makes the pipeline, the map and
 * the agent runnable end to end - twelve drivers across five districts.
 *
 * All of it is synthetic. Real driver telemetry is a location trace of an
 * identifiable person and has no business in a demo repository.
 */
import type { Driver, Territory } from '../platform/types.ts';
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
 * The starter fleet.
 *
 * Driver ids match the vendor fixtures deliberately: drv-0142 appears in both
 * the Samsara and Lytx feeds, which is what makes cross-vendor corroboration
 * demonstrable rather than merely asserted.
 */
export const DRIVERS: Omit<Driver, 'tenantId'>[] = [
  { driverId: 'drv-0142', name: 'A. Okafor',   districtId: 'dal', vehicleId: 'TRK-8891', status: 'driving',  lon: -96.7970,  lat: 32.7767, hosRemainingMinutes: 34,  updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0143', name: 'B. Nguyen',   districtId: 'dal', vehicleId: 'TRK-8893', status: 'driving',  lon: -96.8100,  lat: 32.7900, hosRemainingMinutes: 210, updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0144', name: 'C. Alvarez',  districtId: 'dal', vehicleId: 'TRK-8894', status: 'stopped',  lon: -96.7850,  lat: 32.7600, hosRemainingMinutes: 305, updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0187', name: 'D. Whitfield', districtId: 'aus', vehicleId: 'TRK-8892', status: 'stopped', lon: -97.7431,  lat: 30.2672, hosRemainingMinutes: 330, updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0188', name: 'E. Rasmussen', districtId: 'aus', vehicleId: 'TRK-8895', status: 'driving', lon: -97.7300,  lat: 30.2800, hosRemainingMinutes: 155, updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0311', name: 'F. Delacroix', districtId: 'den', vehicleId: 'TRK-9001', status: 'driving', lon: -104.9903, lat: 39.7392, hosRemainingMinutes: 45,  updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0312', name: 'G. Haugen',   districtId: 'den', vehicleId: 'TRK-9002', status: 'on-break', lon: -104.9700, lat: 39.7500, hosRemainingMinutes: 280, updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0455', name: 'H. Marchetti', districtId: 'chi', vehicleId: 'VZ-4410',  status: 'driving', lon: -87.6298,  lat: 41.8781, hosRemainingMinutes: 310, updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0456', name: 'I. Sørensen', districtId: 'chi', vehicleId: 'VZ-4411',  status: 'driving',  lon: -87.6400,  lat: 41.8900, hosRemainingMinutes: 190, updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0501', name: 'J. Bhattacharya', districtId: 'phx', vehicleId: 'TRK-9100', status: 'driving', lon: -112.0740, lat: 33.4484, hosRemainingMinutes: 240, updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0502', name: 'K. Lindqvist', districtId: 'phx', vehicleId: 'TRK-9101', status: 'off-duty', lon: -112.0600, lat: 33.4600, hosRemainingMinutes: 480, updatedAt: '2026-09-08T14:30:00.000Z' },
  { driverId: 'drv-0503', name: 'L. Achebe',   districtId: 'phx', vehicleId: 'TRK-9102', status: 'stopped',  lon: -112.0900, lat: 33.4300, hosRemainingMinutes: 95,  updatedAt: '2026-09-08T14:30:00.000Z' },
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
