/**
 * The runnable counterpart to postgis-queries.ts.
 *
 * Same semantics as the SQL, executed in memory so the demo works with no
 * database. Each method names the query it stands in for, so you can read the
 * two side by side and see that `ST_DWithin` really is "bbox filter, then exact
 * distance, then sort".
 */
import type { Principal, Site } from '../platform/types.ts';
import { SITES, US_SOUTH_REGION } from '../data/sites.ts';
import { bboxAround, haversineKm, inBBox, pointInPolygon } from './spatial.ts';

export type NearbySite = Site & { distanceKm: number };

/** Tenant-scoped view of the sites table. */
export function allSites(principal: Principal): Site[] {
  return SITES.map((s) => ({ ...s, tenantId: principal.tenantId }));
}

export function getSite(principal: Principal, siteId: string): Site | undefined {
  return allSites(principal).find((s) => s.siteId === siteId);
}

/**
 * Stands in for SQL.sitesWithinRadius.
 *
 * Watch the two phases - this is exactly what the GiST index buys you:
 *   phase 1: bbox filter (cheap, indexable)
 *   phase 2: haversine on the survivors (exact, expensive)
 */
export function sitesWithinRadius(
  principal: Principal,
  centre: { lon: number; lat: number },
  radiusKm: number,
  limit = 50,
): NearbySite[] {
  const box = bboxAround(centre, radiusKm);

  return allSites(principal)
    .filter((s) => inBBox({ lon: s.lon, lat: s.lat }, box))               // phase 1
    .map((s) => ({ ...s, distanceKm: Number(haversineKm(centre, s).toFixed(2)) }))
    .filter((s) => s.distanceKm <= radiusKm)                              // phase 2
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

/** Stands in for SQL.regionContainingPoint (ST_Contains). */
export function regionContaining(point: { lon: number; lat: number }): string | undefined {
  return pointInPolygon(point, US_SOUTH_REGION) ? 'us-south' : undefined;
}

/** Reverse lookup used by the geo-enrichment pipeline step. */
export function locationOf(principal: Principal, siteId: string) {
  const site = getSite(principal, siteId);
  if (!site) return undefined;
  return { lon: site.lon, lat: site.lat, region: site.region };
}
