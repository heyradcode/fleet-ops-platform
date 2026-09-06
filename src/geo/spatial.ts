/**
 * ---------------------------------------------------------------------------
 * Spatial primitives
 * ---------------------------------------------------------------------------
 * In production PostGIS does all of this, in C, against a GiST index. You still
 * need to understand it, because:
 *   - you will do small in-memory checks in a Lambda to avoid a DB round trip;
 *   - you cannot debug a wrong ST_DWithin result if the maths is a black box;
 *   - the coordinate-order trap below is the #1 GIS bug and it is on you.
 *
 * ORDER OF COORDINATES - the single most common bug in anything spatial:
 *   GeoJSON / PostGIS / MapBox GL : [longitude, latitude]   (x, y)
 *   Leaflet / Google Maps / humans: (latitude, longitude)   (y, x)
 * A silently swapped pair puts Dallas in Antarctica. Name your variables
 * `lon`/`lat`, never `a`/`b`, and never `coords[0]`.
 */

export type Point = { lon: number; lat: number };
/** GeoJSON positions are [lon, lat]. Aliased so the order is self-documenting. */
export type Position = [lon: number, lat: number];
export type BBox = [west: number, south: number, east: number, north: number];

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance. This is what PostGIS `ST_Distance(geography, geography)`
 * computes. Note the ~0.5% error versus a true ellipsoid (Vincenty) - fine for
 * "which sites are near the outage", not fine for surveying.
 */
export function haversineKm(a: Point, b: Point): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * A bounding box around a point, in degrees.
 *
 * WHY BOTHER, when haversine is exact? Because a bbox is INDEXABLE. The classic
 * two-phase spatial query is:
 *   1. cheap bbox filter using the index  -> a handful of candidates
 *   2. exact distance on those candidates -> the answer
 * PostGIS's `&&` operator is phase 1 and `ST_DWithin` bundles both. Knowing
 * that this is what happens under the hood is the point.
 */
export function bboxAround(centre: Point, radiusKm: number): BBox {
  const latDelta = radiusKm / 111.32;
  // Longitude degrees shrink towards the poles - hence the cos(lat) term.
  const lonDelta = radiusKm / (111.32 * Math.cos(toRad(centre.lat)) || 1);
  return [centre.lon - lonDelta, centre.lat - latDelta, centre.lon + lonDelta, centre.lat + latDelta];
}

export function inBBox(p: Point, box: BBox): boolean {
  const [west, south, east, north] = box;
  return p.lon >= west && p.lon <= east && p.lat >= south && p.lat <= north;
}

/**
 * Ray casting - is a point inside a polygon? Equivalent to `ST_Contains`.
 * Used here for "which service region does this site fall in".
 * `ring` is a GeoJSON linear ring: [lon, lat] positions, first == last.
 */
export function pointInPolygon(p: Point, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > p.lat !== yj > p.lat &&
      p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Mean centre of a set of points - where to drop the incident marker. */
export function centroid(points: Point[]): Point {
  if (points.length === 0) throw new Error('centroid of empty set');
  const sum = points.reduce((acc, p) => ({ lon: acc.lon + p.lon, lat: acc.lat + p.lat }), { lon: 0, lat: 0 });
  return { lon: sum.lon / points.length, lat: sum.lat / points.length };
}
