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
import type { DeviceState, Observation, Severity } from '../platform/types.ts';

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
 * Devices + their worst current observation, as a FeatureCollection.
 * This is literally the payload the operations board fetches.
 *
 * EVERY DEVICE AT A SITE SHARES ONE COORDINATE, which is a real difference from
 * a fleet map and shapes the whole design of the board. Trucks are spread
 * across a district and a scatter plot is informative; forty switches in one
 * building are one dot with forty things behind it. So the map is a SITE view
 * with severity rolled up, and the device detail lives in a panel beside it
 * rather than in overlapping markers nobody can click.
 */
export function devicesToFeatureCollection(
  devices: DeviceState[],
  observationsByDevice: Map<string, Observation[]>,
): GeoFeatureCollection {
  const rank: Record<Severity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };

  const features = devices.map((device) => {
    const observations = observationsByDevice.get(device.deviceId) ?? [];
    const worst = observations.reduce<Severity>(
      (acc, o) => (rank[o.severity] > rank[acc] ? o.severity : acc),
      'ok',
    );

    return {
      type: 'Feature',
      id: device.deviceId,
      geometry: point(device.lon, device.lat),
      properties: {
        deviceId: device.deviceId,
        name: device.name,
        siteId: device.siteId,
        role: device.role,
        vendor: device.vendor,
        status: device.status,
        interfacesDown: device.interfacesDown,
        cpuUtilisation: device.cpuUtilisation,
        // The board styles straight off these two - colour from severity,
        // radius from urgency. Data-driven styling runs on the GPU, so there
        // is no per-feature JavaScript and no re-render loop.
        severity: worst,
        observationCount: observations.length,
        // Weighted by ROLE as well as severity. A saturated core switch and a
        // saturated access point are the same number and very different news;
        // without this the map draws them identically and the eye goes to
        // whichever happens to be on top.
        urgency: Math.round(
          rank[worst] * 25 + roleWeight(device.role) * 15 + device.interfacesDown * 2,
        ),
      },
    } satisfies GeoFeature;
  });

  return { type: 'FeatureCollection', features, bbox: computeBBox(features) };
}

/** How much of the estate sits underneath this kind of box. */
function roleWeight(role: DeviceState['role']): number {
  switch (role) {
    case 'core': return 4;
    case 'wan-edge': return 3;
    case 'distribution': return 2;
    case 'firewall': return 2;
    case 'access': return 1;
    case 'wireless-ap': return 0;
  }
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
