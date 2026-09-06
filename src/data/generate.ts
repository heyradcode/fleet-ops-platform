/**
 * ---------------------------------------------------------------------------
 * The synthetic fleet
 * ---------------------------------------------------------------------------
 * Every driver, position and reading in this repository is generated. That is
 * not a limitation to apologise for - real driver telemetry is a location trace
 * of an identifiable person, and a public portfolio repository is the last
 * place it belongs.
 *
 * TWO RULES THIS FILE FOLLOWS:
 *
 *   1. SEEDED, NEVER `Math.random()`. A demo whose output changes on every run
 *      cannot be narrated, screenshotted, diffed against the previous run, or
 *      asserted against in a test. The generator draws from platform/random.ts,
 *      which the demo and the tests seed to a constant.
 *   2. GENERATED AT RUNTIME, not committed as JSON. The generator is readable
 *      code that shows what a fleet actually looks like; a 10,000-line fixture
 *      file shows nothing and rots the moment the model changes.
 *
 * Scale here is deliberately small - 60 drivers, not 330,000. The architecture
 * is sized for the larger number and the arithmetic is in the docs; this runs
 * the smaller one so the whole thing fits in a terminal and in your head.
 */
import type { Driver, DriverStatus, Telemetry } from '../platform/types.ts';
import { DISTRICTS } from './districts.ts';
import { CORRIDORS, corridorsFor, pointAlong } from './polylines.ts';
import { seededRandom, DEMO_SEED, type Random } from '../platform/random.ts';
import { DEMO_EPOCH } from '../platform/clock.ts';
import { telemetryId } from '../platform/ids.ts';

/** Surnames drawn from a deliberately wide range of origins. */
const SURNAMES = [
  'Okafor', 'Nguyen', 'Alvarez', 'Whitfield', 'Rasmussen', 'Delacroix',
  'Haugen', 'Marchetti', 'Sorensen', 'Bhattacharya', 'Lindqvist', 'Achebe',
  'Kowalczyk', 'Fitzgerald', 'Yamamoto', 'Oyelaran', 'Novak', 'Petrov',
  'Silva', 'Kaur', 'Mbeki', 'Larsen', 'Rossi', 'Duarte',
];
const INITIALS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Drivers per district. Sixty in total, deliberately UNEVEN.
 *
 * Real dispatch districts are not the same size, and the difference matters
 * beyond realism: an uneven fleet is what makes the hot-partition problem
 * concrete. `PK = DISTRICT#<id>` would concentrate Dallas's writes onto one
 * partition while the others idle - which is exactly why the hot-state item is
 * keyed `PK = DRIVER#<id>` and district lookup goes through a GSI instead.
 */
const PER_DISTRICT: Record<string, number> = {
  dal: 16,        // the big one
  aus: 11,
  den: 11,
  chi: 11,
  phx: 11,
};

export type GeneratedDriver = Omit<Driver, 'tenantId'> & {
  /** Which corridor this driver runs, and how far along they start. */
  corridorId: string;
  progress: number;
  /** Metres per tick along the corridor, as a fraction of its length. */
  speed: number;
};

/**
 * Build the fleet.
 *
 * Deterministic: the same seed always produces the same sixty drivers, on the
 * same corridors, at the same starting positions.
 */
export function generateFleet(seed = DEMO_SEED): GeneratedDriver[] {
  const rnd = seededRandom(seed);
  const drivers: GeneratedDriver[] = [];
  let n = 0;

  for (const district of DISTRICTS) {
    const corridors = corridorsFor(district.districtId);

    const count = PER_DISTRICT[district.districtId] ?? 11;
    for (let i = 0; i < count; i++) {
      const corridor = corridors[i % corridors.length];
      const progress = rnd();
      const status = statusFor(rnd);
      const [lon, lat] = pointAlong(corridor, progress);

      // Hours-of-service: most drivers have plenty, a few are getting close.
      // The distribution matters - a fleet where everyone is about to time out
      // is not a fleet, it is a compliance incident.
      const hos = status === 'off-duty'
        ? 660
        : Math.round(30 + rnd() * rnd() * 600);   // squared: skews high, tail low

      drivers.push({
        driverId: 'drv-' + String(1000 + n).padStart(4, '0'),
        name: INITIALS[n % 26] + '. ' + SURNAMES[n % SURNAMES.length],
        districtId: district.districtId,
        vehicleId: 'TRK-' + String(8000 + n * 7),
        status,
        lon: round6(lon),
        lat: round6(lat),
        hosRemainingMinutes: hos,
        updatedAt: new Date(DEMO_EPOCH).toISOString(),
        corridorId: corridor.corridorId,
        progress,
        // A slow crawl along the corridor per tick. Real speed varies far more;
        // what matters here is that pins move plausibly, not that they are
        // simulated to any fidelity.
        speed: 0.004 + rnd() * 0.010,
      });
      n++;
    }
  }
  return drivers;
}

function statusFor(rnd: Random): DriverStatus {
  const r = rnd();
  if (r < 0.62) return 'driving';
  if (r < 0.80) return 'stopped';
  if (r < 0.92) return 'on-break';
  return 'off-duty';
}

const round6 = (n: number) => Number(n.toFixed(6));

// ---------------------------------------------------------------------------
// The replayable trace
// ---------------------------------------------------------------------------

export type Tick = {
  index: number;
  /** Wall-clock instant of this tick. */
  at: string;
  readings: Telemetry[];
};

export type TraceOptions = {
  tenantId: string;
  /** How many ticks to generate. 60 ticks x 30s = 30 minutes. */
  ticks?: number;
  intervalMs?: number;
  seed?: number;
};

/**
 * A replayable telemetry trace: every driver, every tick.
 *
 * This is what makes the dispatch board a product rather than a screenshot.
 * Scrubbing the board backwards and forwards is replaying this list while
 * advancing platform/clock.ts, which is precisely why that clock has an
 * `advance()`.
 *
 * Only `position` readings are generated here. Exceptions come from the
 * scenarios in scenarios.ts, because an exception should be a deliberate,
 * explainable event rather than something the random number generator
 * occasionally produces.
 */
export function generateTrace(options: TraceOptions): Tick[] {
  const { tenantId, ticks = 60, intervalMs = 30_000, seed = DEMO_SEED } = options;
  const rnd = seededRandom(seed ^ 0x7a5c);          // a different stream to the fleet
  const fleet = generateFleet(seed);
  const byId = new Map(CORRIDORS.map((c) => [c.corridorId, c]));

  const out: Tick[] = [];

  for (let t = 0; t < ticks; t++) {
    const at = new Date(DEMO_EPOCH + t * intervalMs).toISOString();
    const readings: Telemetry[] = [];

    for (const driver of fleet) {
      // A parked truck does not move, and reporting a position for it every
      // 30 seconds anyway is exactly what real devices do.
      const moving = driver.status === 'driving';
      const corridor = byId.get(driver.corridorId)!;
      const progress = moving
        ? wrap(driver.progress + driver.speed * t)
        : driver.progress;

      const [lon, lat] = pointAlong(corridor, progress);
      const speedKph = moving ? Math.round(70 + rnd() * 40) : 0;

      readings.push({
        tenantId,
        telemetryId: telemetryId('samsara', driver.vehicleId + ':gps', at),
        provider: 'samsara',
        domain: 'telematics',
        kind: 'position',
        driverId: driver.driverId,
        sourceRef: driver.vehicleId,
        value: speedKph,
        unit: 'kph',
        severity: 'ok',
        observedAt: at,
        location: { lon: round6(lon), lat: round6(lat), district: driver.districtId },
        attributes: { corridorId: corridor.corridorId, status: driver.status },
      });
    }

    out.push({ index: t, at, readings });
  }

  return out;
}

/** Corridors loop, so a driver who runs off the end reappears at the start. */
function wrap(t: number): number {
  const m = t % 1;
  return m < 0 ? m + 1 : m;
}

/** The fleet as plain `Driver` records, for seeding the repository. */
export function fleetAsDrivers(tenantId: string, seed = DEMO_SEED): Driver[] {
  return generateFleet(seed).map(({ corridorId, progress, speed, ...driver }) => ({
    tenantId,
    ...driver,
  }));
}
