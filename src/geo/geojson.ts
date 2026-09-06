/**
 * ---------------------------------------------------------------------------
 * GeoJSON (RFC 7946) - the wire format for everything spatial
 * ---------------------------------------------------------------------------
 * Three things to know:
 *   1. Positions are [lon, lat] (and optionally elevation).
 *   2. A Feature is geometry + arbitrary `properties`. The properties bag is
 *      how you get your business data onto the map - MapBox styles read it
 *      directly, so `severity` in properties becomes marker colour with no
 *      client-side code at all.
 *   3. The CRS is always WGS84 (EPSG:4326). RFC 7946 removed the `crs` member;
 *      if a vendor sends you EPSG:3857 "GeoJSON", it is not GeoJSON.
 */
import type { Position } from './spatial.ts';
import type { Signal, Site } from '../platform/types.ts';

export type GeoGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'Polygon'; coordinates: Position[][] };  // [outer ring, ...holes]

export type GeoFeature<P = Record<string, unknown>> = {
  type: 'Feature';
  geometry: GeoGeometry;
  properties: P;
  id?: string;
};

export type GeoFeatureCollection<P = Record<string, unknown>> = {
  type: 'FeatureCollection';
  features: GeoFeature<P>[];
  bbox?: [number, number, number, number];
};

export function point(lon: number, lat: number): GeoGeometry {
  return { type: 'Point', coordinates: [lon, lat] };
}

export function polygon(ring: Position[]): GeoGeometry {
  return { type: 'Polygon', coordinates: [closeRing(ring)] };
}

/** RFC 7946 requires a closed ring. Silently fixing it saves a lot of pain. */
function closeRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring;
  const [first] = ring;
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

/**
 * Sites + their worst current signal, as a FeatureCollection.
 * This is literally the payload the map front-end fetches.
 */
export function sitesToFeatureCollection(
  sites: Site[],
  signalsBySite: Map<string, Signal[]>,
): GeoFeatureCollection {
  const rank = { ok: 0, info: 1, warning: 2, critical: 3 };

  const features = sites.map((site) => {
    const signals = signalsBySite.get(site.siteId) ?? [];
    const worst = signals.reduce<Signal['severity']>(
      (acc, s) => (rank[s.severity] > rank[acc] ? s.severity : acc),
      'ok',
    );

    return {
      type: 'Feature',
      id: site.siteId,
      geometry: point(site.lon, site.lat),
      properties: {
        siteId: site.siteId,
        name: site.name,
        region: site.region,
        headcount: site.headcount,
        severity: worst,              // MapBox styles colour straight off this
        signalCount: signals.length,
        // Weighted "how much do we care" - drives circle radius on the map.
        impactScore: Math.round(rank[worst] * Math.log10(site.headcount + 1) * 10),
      },
    } satisfies GeoFeature;
  });

  return { type: 'FeatureCollection', features, bbox: computeBBox(features) };
}

/** A FeatureCollection bbox lets the client fit the viewport in one step. */
export function computeBBox(features: GeoFeature[]): [number, number, number, number] {
  let west = 180, south = 90, east = -180, north = -90;

  for (const f of features) {
    for (const [lon, lat] of positionsOf(f.geometry)) {
      west = Math.min(west, lon); east = Math.max(east, lon);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
  }
  return [west, south, east, north];
}

function positionsOf(g: GeoGeometry): Position[] {
  if (g.type === 'Point') return [g.coordinates];
  if (g.type === 'LineString') return g.coordinates;
  return g.coordinates.flat();
}
