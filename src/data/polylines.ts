/**
 * ---------------------------------------------------------------------------
 * Route corridors - the roads drivers actually move along
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL, given that a random walk would be less work:
 *
 * A random walk sends trucks diagonally across the Trinity River, through
 * DFW's runways, and over Lake Michigan. At district zoom that is invisible.
 * The moment anyone zooms in - which is the first thing a person with fleet
 * experience does - it is obvious the data is fake, and everything else on the
 * screen inherits that doubt.
 *
 * Interpolating along a handful of hand-drawn corridors costs an afternoon and
 * removes the tell entirely. It also makes `route-adherence` a real measurement
 * rather than a made-up number: distance from the corridor is the actual thing
 * the rule is about, and a road closure is a cluster of drivers leaving the
 * SAME corridor at the SAME point - which is exactly what detectIncidents
 * merges on.
 *
 * Alignments follow real interstates approximately. They are not survey-grade
 * and are not meant to be; they are meant to look like roads at the zoom level
 * a dispatch board is used at.
 *
 * Remember: [lon, lat]. Always.
 */
import type { Position } from '../geo/spatial.ts';

export type Corridor = {
  corridorId: string;
  districtId: string;
  /** Human name, shown on the board and used in incident titles. */
  name: string;
  /** Ordered waypoints, [lon, lat]. */
  path: Position[];
};

export const CORRIDORS: Corridor[] = [
  // --- Dallas -------------------------------------------------------------
  {
    corridorId: 'dal-i35e', districtId: 'dal', name: 'I-35E',
    path: [
      [-96.8520, 33.0480], [-96.8410, 32.9620], [-96.8330, 32.8850],
      [-96.8080, 32.8090], [-96.8020, 32.7480], [-96.8190, 32.6720],
    ],
  },
  {
    corridorId: 'dal-i30', districtId: 'dal', name: 'I-30',
    path: [
      [-97.0410, 32.7480], [-96.9520, 32.7610], [-96.8710, 32.7740],
      [-96.7580, 32.7830], [-96.6420, 32.8010], [-96.5510, 32.8090],
    ],
  },
  {
    corridorId: 'dal-us75', districtId: 'dal', name: 'US-75 Central',
    path: [
      [-96.7970, 32.7880], [-96.7710, 32.8520], [-96.7480, 32.9210],
      [-96.7280, 32.9940], [-96.7020, 33.0810],
    ],
  },

  // --- Austin -------------------------------------------------------------
  {
    corridorId: 'aus-i35', districtId: 'aus', name: 'I-35',
    path: [
      [-97.6810, 30.5020], [-97.6980, 30.4110], [-97.7120, 30.3320],
      [-97.7390, 30.2680], [-97.7610, 30.1880], [-97.7820, 30.1020],
    ],
  },
  {
    corridorId: 'aus-mopac', districtId: 'aus', name: 'MoPac (Loop 1)',
    path: [
      [-97.7690, 30.4480], [-97.7740, 30.3810], [-97.7780, 30.3120],
      [-97.7830, 30.2510], [-97.7910, 30.2010],
    ],
  },
  {
    corridorId: 'aus-us183', districtId: 'aus', name: 'US-183',
    path: [
      [-97.9010, 30.4220], [-97.8210, 30.3810], [-97.7420, 30.3280],
      [-97.6710, 30.2610], [-97.6020, 30.2010],
    ],
  },

  // --- Denver -------------------------------------------------------------
  {
    corridorId: 'den-i25', districtId: 'den', name: 'I-25',
    path: [
      [-104.9780, 39.9510], [-104.9840, 39.8620], [-104.9890, 39.7810],
      [-104.9910, 39.7010], [-104.9950, 39.6120], [-105.0010, 39.5510],
    ],
  },
  {
    corridorId: 'den-i70', districtId: 'den', name: 'I-70',
    path: [
      [-105.2010, 39.7420], [-105.1120, 39.7480], [-105.0210, 39.7620],
      [-104.9310, 39.7780], [-104.8210, 39.7840], [-104.7510, 39.7860],
    ],
  },
  {
    corridorId: 'den-c470', districtId: 'den', name: 'C-470',
    path: [
      [-105.1010, 39.5820], [-105.0410, 39.5710], [-104.9710, 39.5680],
      [-104.9010, 39.5720], [-104.8510, 39.5810],
    ],
  },

  // --- Chicago ------------------------------------------------------------
  {
    corridorId: 'chi-i90', districtId: 'chi', name: 'I-90/94 Kennedy',
    path: [
      [-87.6520, 42.0180], [-87.6620, 41.9510], [-87.6480, 41.9010],
      [-87.6310, 41.8620], [-87.6240, 41.8010], [-87.6180, 41.7220],
    ],
  },
  {
    corridorId: 'chi-i55', districtId: 'chi', name: 'I-55 Stevenson',
    path: [
      [-87.6280, 41.8520], [-87.6810, 41.8210], [-87.7420, 41.7910],
      [-87.8110, 41.7520], [-87.8910, 41.7020],
    ],
  },
  {
    corridorId: 'chi-i290', districtId: 'chi', name: 'I-290 Eisenhower',
    path: [
      [-87.6310, 41.8780], [-87.7010, 41.8740], [-87.7810, 41.8720],
      [-87.8610, 41.8710], [-87.9410, 41.8690],
    ],
  },

  // --- Phoenix ------------------------------------------------------------
  {
    corridorId: 'phx-i10', districtId: 'phx', name: 'I-10',
    path: [
      [-112.3010, 33.4520], [-112.2210, 33.4480], [-112.1410, 33.4420],
      [-112.0610, 33.4380], [-111.9810, 33.4210], [-111.9010, 33.3980],
    ],
  },
  {
    corridorId: 'phx-i17', districtId: 'phx', name: 'I-17',
    path: [
      [-112.1010, 33.6520], [-112.0980, 33.5810], [-112.0910, 33.5120],
      [-112.0860, 33.4620], [-112.0810, 33.4020],
    ],
  },
  {
    corridorId: 'phx-loop202', districtId: 'phx', name: 'Loop 202',
    path: [
      [-111.9510, 33.4280], [-111.9210, 33.4710], [-111.9010, 33.5210],
      [-111.8910, 33.5620],
    ],
  },
];

export function corridorsFor(districtId: string): Corridor[] {
  return CORRIDORS.filter((c) => c.districtId === districtId);
}

export function corridorById(corridorId: string): Corridor | undefined {
  return CORRIDORS.find((c) => c.corridorId === corridorId);
}

/**
 * A point `t` of the way along a corridor, 0 to 1.
 *
 * Linear interpolation between waypoints, weighted by segment length so a
 * driver moves at a constant-ish speed rather than sprinting through short
 * segments and crawling through long ones.
 */
export function pointAlong(corridor: Corridor, t: number): Position {
  const path = corridor.path;
  if (path.length === 0) return [0, 0];
  if (path.length === 1) return path[0];

  const clamped = Math.max(0, Math.min(1, t));

  // Segment lengths in degrees. Good enough for interpolation - this is not a
  // distance calculation, and haversine would add cost for no visible change.
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i][0] - path[i - 1][0];
    const dy = path[i][1] - path[i - 1][1];
    const len = Math.hypot(dx, dy);
    lengths.push(len);
    total += len;
  }

  let target = clamped * total;
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] === 0 ? 0 : target / lengths[i];
      const [x0, y0] = path[i];
      const [x1, y1] = path[i + 1];
      return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
    }
    target -= lengths[i];
  }
  return path[path.length - 1];
}

/**
 * Shortest distance from a point to a corridor, in metres.
 *
 * This is what the `route-adherence` reading measures, and what makes a road
 * closure detectable: several drivers whose distance from the same corridor
 * jumps at the same place, at the same time.
 *
 * Point-to-segment distance in a local planar approximation. Over a few
 * kilometres at these latitudes the error is well under the threshold the rule
 * cares about; a production implementation would use PostGIS
 * `ST_Distance(geography)` and get it exactly right.
 */
export function metresFromCorridor(point: { lon: number; lat: number }, corridor: Corridor): number {
  const latScale = 111_320;                                   // metres per degree latitude
  const lonScale = 111_320 * Math.cos((point.lat * Math.PI) / 180);

  const px = point.lon * lonScale;
  const py = point.lat * latScale;

  let best = Infinity;
  for (let i = 1; i < corridor.path.length; i++) {
    const ax = corridor.path[i - 1][0] * lonScale;
    const ay = corridor.path[i - 1][1] * latScale;
    const bx = corridor.path[i][0] * lonScale;
    const by = corridor.path[i][1] * latScale;

    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    // Project the point onto the segment, clamped to its endpoints.
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const cx = ax + t * dx;
    const cy = ay + t * dy;

    best = Math.min(best, Math.hypot(px - cx, py - cy));
  }
  return Math.round(best);
}

/** The corridor a point is closest to, and how far off it is. */
export function nearestCorridor(
  point: { lon: number; lat: number },
  districtId?: string,
): { corridor: Corridor; metres: number } | undefined {
  const candidates = districtId ? corridorsFor(districtId) : CORRIDORS;
  let best: { corridor: Corridor; metres: number } | undefined;

  for (const corridor of candidates) {
    const metres = metresFromCorridor(point, corridor);
    if (!best || metres < best.metres) best = { corridor, metres };
  }
  return best;
}
