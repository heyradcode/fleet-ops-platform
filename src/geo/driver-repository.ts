/**
 * The runnable counterpart to postgis-queries.ts.
 *
 * Same semantics as the SQL, executed in memory so the demo works with no
 * database. Each function names the query it stands in for, so you can read the
 * two side by side and see that `ST_DWithin` really is "bbox filter, then exact
 * distance, then sort".
 *
 * Note what a fleet changes about this: the things being queried MOVE. `allDrivers` is a snapshot of hot state, not a slowly
 * changing dimension - which is why the real thing reads from DynamoDB rather
 * than Aurora, and why position history lives in S3.
 */
import type { Driver, Principal, Territory } from '../platform/types.ts';
import { DISTRICTS, US_SOUTH_REGION } from '../data/districts.ts';
import { fleetAsDrivers } from '../data/generate.ts';
import { bboxAround, haversineKm, inBBox, pointInPolygon } from './spatial.ts';

export type NearbyDriver = Driver & { distanceKm: number };

/**
 * Tenant-scoped view of the drivers table.
 *
 * Sourced from the seeded generator, so the whole demo - the board, the
 * scenarios, the agent's tools - reasons about ONE fleet of sixty drivers
 * rather than two disjoint populations that happen to share a schema.
 */
export function allDrivers(principal: Principal): Driver[] {
  return fleetAsDrivers(principal.tenantId);
}

export function getDriver(principal: Principal, driverId: string): Driver | undefined {
  return allDrivers(principal).find((d) => d.driverId === driverId);
}

/** Tenant-scoped view of the districts table. */
export function allDistricts(principal: Principal): Territory[] {
  return DISTRICTS.map((t) => ({ ...t, tenantId: principal.tenantId }));
}

/**
 * Stands in for SQL.driversWithinRadius.
 *
 * Watch the two phases - this is exactly what the GiST index buys you:
 *   phase 1: bbox filter (cheap, indexable)
 *   phase 2: haversine on the survivors (exact, expensive)
 *
 * This is also the query behind "who else can take this load?", so it filters
 * to drivers who could actually accept one.
 */
export function driversWithinRadius(
  principal: Principal,
  centre: { lon: number; lat: number },
  radiusKm: number,
  limit = 50,
): NearbyDriver[] {
  const box = bboxAround(centre, radiusKm);

  return allDrivers(principal)
    .filter((d) => inBBox({ lon: d.lon, lat: d.lat }, box))                // phase 1
    .map((d) => ({ ...d, distanceKm: Number(haversineKm(centre, d).toFixed(2)) }))
    .filter((d) => d.distanceKm <= radiusKm)                               // phase 2
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

/**
 * Drivers who could take on reassigned work.
 *
 * Off-duty drivers are excluded for a legal reason, not a preference: dispatching
 * a driver with no hours left is an hours-of-service violation, and the platform
 * should never surface the option.
 */
export function availableDriversNear(
  principal: Principal,
  centre: { lon: number; lat: number },
  radiusKm: number,
): NearbyDriver[] {
  return driversWithinRadius(principal, centre, radiusKm)
    .filter((d) => d.status !== 'off-duty' && d.hosRemainingMinutes > 60);
}

/** Stands in for SQL.regionContainingPoint (ST_Contains). */
export function regionContaining(point: { lon: number; lat: number }): string | undefined {
  return pointInPolygon(point, US_SOUTH_REGION) ? 'us-south' : undefined;
}

/**
 * Which district a point falls in.
 *
 * Nearest-depot is a stand-in for real territory polygons; the production query
 * is `ST_Contains(territory.boundary, point)` against the districts table.
 * The polygons themselves are a data-loading job, not a code change.
 */
export function districtContaining(
  principal: Principal,
  point: { lon: number; lat: number },
): string | undefined {
  let best: { districtId: string; km: number } | undefined;
  for (const t of allDistricts(principal)) {
    const km = haversineKm(point, t);
    if (!best || km < best.km) best = { districtId: t.districtId, km };
  }
  return best?.districtId;
}

/** Reverse lookup used by the resolveTerritory pipeline step. */
export function locationOf(principal: Principal, driverId: string) {
  const driver = getDriver(principal, driverId);
  if (!driver) return undefined;
  return { lon: driver.lon, lat: driver.lat, district: driver.districtId };
}
