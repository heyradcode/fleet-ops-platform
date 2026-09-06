/**
 * Seed data: five US sites and one service region polygon.
 *
 * In production this lives in Aurora PostgreSQL with PostGIS (see
 * src/data/schema.sql) and is cached into DynamoDB for the hot read path.
 */
import type { Site } from '../platform/types.ts';
import type { Position } from '../geo/spatial.ts';

export const SITES: Omit<Site, 'tenantId'>[] = [
  { siteId: 'dal-01', name: 'Dallas HQ',          region: 'us-south',   lon: -96.7970, lat: 32.7767, headcount: 1200 },
  { siteId: 'aus-01', name: 'Austin Campus',      region: 'us-south',   lon: -97.7431, lat: 30.2672, headcount: 640 },
  { siteId: 'den-01', name: 'Denver Office',      region: 'us-west',    lon: -104.9903, lat: 39.7392, headcount: 310 },
  { siteId: 'chi-01', name: 'Chicago Datacentre', region: 'us-central', lon: -87.6298, lat: 41.8781, headcount: 85 },
  { siteId: 'phx-01', name: 'Phoenix Branch',     region: 'us-west',    lon: -112.0740, lat: 33.4484, headcount: 140 },
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
