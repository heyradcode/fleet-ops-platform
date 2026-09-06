/**
 * ---------------------------------------------------------------------------
 * TopoJSON - GeoJSON that stopped repeating itself
 * ---------------------------------------------------------------------------
 * Why it exists: in GeoJSON, Texas and Oklahoma each store the border between
 * them, in full, independently. Every shared edge is duplicated. For US
 * counties that is ~10 MB of GeoJSON your mobile users have to download.
 *
 * TopoJSON stores each shared edge ONCE, as an "arc", and each shape becomes a
 * list of arc indices. Two more tricks compound it:
 *
 *   QUANTISATION - snap coordinates to a fixed grid, so they become small
 *                  integers instead of 15-significant-digit floats.
 *   DELTA ENCODING - store each point as an offset from the previous one, so
 *                  the integers are tiny (and gzip loves them).
 *
 * Result: routinely 80-90% smaller than the same GeoJSON. The cost is that
 * nothing consumes TopoJSON directly - the client calls `topojson.feature()`
 * to expand it back to GeoJSON before rendering.
 *
 * WHEN TO USE WHICH, the answer they are listening for:
 *   GeoJSON  - points, small/simple geometry, anything an API returns per-request.
 *   TopoJSON - large polygon sets with shared borders, served from S3+CloudFront
 *              and cached hard, because it is a static basemap that rarely changes.
 *
 * The encoder below is genuine (quantise + delta) but does not do arc
 * de-duplication, which needs a full topology build. The size win it does show
 * is real, and it is the part you can explain from memory.
 */
import type { GeoFeatureCollection } from './geojson.ts';
import type { Position } from './spatial.ts';

export type Topology = {
  type: 'Topology';
  /** Maps quantised integer space back to real coordinates. */
  transform: { scale: [number, number]; translate: [number, number] };
  /** Shared, delta-encoded coordinate sequences. */
  arcs: number[][][];
  objects: Record<string, { type: 'GeometryCollection'; geometries: TopoGeometry[] }>;
};

export type TopoGeometry = {
  type: 'Point' | 'Polygon';
  /** Points keep inline coordinates; polygons reference arcs by index. */
  coordinates?: [number, number];
  arcs?: number[][];
  properties: Record<string, unknown>;
  id?: string;
};

/** Encode a FeatureCollection as a quantised, delta-encoded topology. */
export function encode(fc: GeoFeatureCollection, quantisation = 10_000): Topology {
  const [west, south, east, north] = fc.bbox ?? [-180, -90, 180, 90];

  // scale = how many real degrees one integer step represents.
  const scale: [number, number] = [
    (east - west) / (quantisation - 1) || 1,
    (north - south) / (quantisation - 1) || 1,
  ];
  const translate: [number, number] = [west, south];

  const quantise = (p: Position): [number, number] => [
    Math.round((p[0] - translate[0]) / scale[0]),
    Math.round((p[1] - translate[1]) / scale[1]),
  ];

  const arcs: number[][][] = [];
  const geometries: TopoGeometry[] = [];

  for (const f of fc.features) {
    if (f.geometry.type === 'Point') {
      geometries.push({
        type: 'Point',
        coordinates: quantise(f.geometry.coordinates),
        properties: f.properties,
        id: f.id,
      });
    } else if (f.geometry.type === 'Polygon') {
      const ringIndices = f.geometry.coordinates.map((ring) => {
        arcs.push(deltaEncode(ring.map(quantise)));
        return arcs.length - 1;
      });
      geometries.push({ type: 'Polygon', arcs: [ringIndices], properties: f.properties, id: f.id });
    }
  }

  return {
    type: 'Topology',
    transform: { scale, translate },
    arcs,
    objects: { drivers: { type: 'GeometryCollection', geometries } },
  };
}

/** [[10,20],[12,25],[11,30]] -> [[10,20],[2,5],[-1,5]] */
function deltaEncode(points: Array<[number, number]>): number[][] {
  let prevX = 0, prevY = 0;
  return points.map(([x, y]) => {
    const out = [x - prevX, y - prevY];
    prevX = x; prevY = y;
    return out;
  });
}

/** The inverse - what `topojson.feature()` does in the browser. */
export function decodePoint(topo: Topology, g: TopoGeometry): Position {
  const [x, y] = g.coordinates ?? [0, 0];
  return [
    x * topo.transform.scale[0] + topo.transform.translate[0],
    y * topo.transform.scale[1] + topo.transform.translate[1],
  ];
}

export function compressionRatio(fc: GeoFeatureCollection, topo: Topology): number {
  const a = JSON.stringify(fc).length;
  const b = JSON.stringify(topo).length;
  return Number((1 - b / a).toFixed(3));
}
