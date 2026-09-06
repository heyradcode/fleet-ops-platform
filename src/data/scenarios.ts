/**
 * ---------------------------------------------------------------------------
 * Scenarios - synthetic data that argues for something
 * ---------------------------------------------------------------------------
 * Fixture data usually just fills a screen. These six exist to prove one claim
 * each about how the platform behaves, and they are the reason the pipeline's
 * rules can be demonstrated rather than described:
 *
 *   road-closure    fourteen drivers, ONE incident. Not fourteen pages.
 *   gps-drift       a lone deviation with nothing corroborating it raises
 *                   NOTHING. This is the most valuable of the six: anyone can
 *                   show a dashboard lighting up; showing the noise filter
 *                   working is the harder and more convincing thing.
 *   harsh-braking   an accelerometer and a dashcam, two vendors, one event.
 *   hos-risk        a regulatory clock running out - authoritative, so it
 *                   escalates without waiting for a second opinion.
 *   panic           a person pressed a button. Sub-second path, no batching,
 *                   no corroboration.
 *   poison-record   one unparseable payload in a batch of many. The batch is
 *                   bisected, the bad record is parked, and the shard keeps
 *                   moving.
 *
 * Each scenario emits VENDOR-SHAPED payloads, not canonical Telemetry, so the
 * data travels the real path: fetchRaw -> normalise -> resolve -> evaluate ->
 * detect. A scenario that skipped normalisation would prove nothing about the
 * layer most likely to contain the bug.
 */
import type { RawRecord } from '../platform/types.ts';
import { DEMO_EPOCH } from '../platform/clock.ts';
import { generateFleet } from './generate.ts';
import { corridorById, pointAlong } from './polylines.ts';

export type ScenarioId =
  | 'road-closure'
  | 'gps-drift'
  | 'harsh-braking'
  | 'hos-risk'
  | 'panic'
  | 'poison-record';

export type Scenario = {
  id: ScenarioId;
  /** One line, shown in the demo. */
  title: string;
  /** The claim this scenario exists to demonstrate. */
  proves: string;
  /** Vendor payloads, exactly as the connectors would receive them. */
  build(tenantId: string): RawRecord[];
};

const iso = (offsetMs = 0) => new Date(DEMO_EPOCH + offsetMs).toISOString();

/** Drivers in a district, from the generated fleet. */
function driversIn(districtId: string) {
  return generateFleet().filter((d) => d.districtId === districtId);
}

// ---------------------------------------------------------------------------

export const SCENARIOS: Scenario[] = [
  {
    id: 'road-closure',
    title: 'Road closure on I-35E, Dallas',
    proves: 'Fourteen affected drivers produce ONE incident, not fourteen pages',
    build(tenantId) {
      // Everyone running the same corridor, stopped within a few hundred metres
      // of the same point, and pushed onto the shoulder and side streets around
      // it. Each driver ends up with TWO kinds of evidence - off-corridor AND
      // stationary - which is what corroborates a deviation when there is only
      // one GPS vendor to hear it from.
      //
      // Note that both come from Samsara. That is deliberate: this carrier runs
      // Samsara, Motive and Lytx, and a dashcam has nothing to say about a road
      // closure. Corroboration here is two kinds of evidence, not two vendors.
      const corridor = corridorById('dal-i35e')!;
      const [blockLon, blockLat] = pointAlong(corridor, 0.42);
      const affected = driversIn('dal').slice(0, 14);

      return [{
        tenantId, provider: 'samsara', fetchedAt: iso(),
        payload: {
          data: affected.map((d, i) => {
            // All diverted to the SAME side - traffic off a closed carriageway
            // goes one way, not both. Each driver ends up 800m-1.2km off the
            // corridor (well past the 400m threshold) and strung ~2km along the
            // frontage road, which keeps every one of them inside the 3km merge
            // radius of the others. If they scattered further, this would
            // correctly become several incidents rather than one.
            const lon = Number((blockLon - 0.0090 - (i % 4) * 0.0020).toFixed(6));
            const lat = Number((blockLat + ((i % 7) - 3) * 0.0035).toFixed(6));
            const at = iso(i * 1_000);
            return {
              id: d.vehicleId,
              name: d.vehicleId,
              externalIds: { driverId: d.driverId },
              gps: {
                time: at, latitude: lat, longitude: lon,
                speedMilesPerHour: 0,
                headingDegrees: 180,
                reverseGeo: { formattedLocation: 'I-35E S, Dallas, TX' },
              },
              engineStates: { time: at, value: 'Idle' },
              // Stopped for twenty-odd minutes. The second signal.
              idleMinutes: 21 + (i % 6),
              harshEvent: null,
            };
          }),
          pagination: { endCursor: null, hasNextPage: false },
        },
      }];
    },
  },

  {
    id: 'gps-drift',
    title: 'A single GPS spike, Austin',
    proves: 'An uncorroborated deviation raises NO incident - the noise filter working',
    build(tenantId) {
      const driver = driversIn('aus')[0];
      // One reading, one vendor, nothing else agreeing. A cheap receiver under
      // an overpass does this several times a shift. If this paged a
      // dispatcher, they would learn to ignore the board within a week.
      return [{
        tenantId, provider: 'samsara', fetchedAt: iso(),
        payload: {
          data: [{
            id: driver.vehicleId,
            name: driver.vehicleId,
            externalIds: { driverId: driver.driverId },
            gps: {
              time: iso(),
              latitude: 30.4102, longitude: -97.8510,   // ~9km off corridor
              speedMilesPerHour: 46,
              headingDegrees: 12,
              reverseGeo: { formattedLocation: 'US-183, Austin, TX' },
            },
            engineStates: { time: iso(), value: 'On' },
            harshEvent: null,
          }],
          pagination: { endCursor: null, hasNextPage: false },
        },
      }];
    },
  },

  {
    id: 'harsh-braking',
    title: 'Hard braking witnessed twice, Denver',
    proves: 'Two independent devices on one truck agreeing is what makes it real',
    build(tenantId) {
      const driver = driversIn('den')[0];
      const at = iso();
      return [
        {
          tenantId, provider: 'samsara', fetchedAt: iso(),
          payload: {
            data: [{
              id: driver.vehicleId, name: driver.vehicleId,
              externalIds: { driverId: driver.driverId },
              gps: {
                time: at, latitude: driver.lat, longitude: driver.lon,
                speedMilesPerHour: 38, headingDegrees: 190,
                reverseGeo: { formattedLocation: 'I-25 S, Denver, CO' },
              },
              engineStates: { time: at, value: 'On' },
              harshEvent: { time: at, behaviourLabel: 'Harsh Braking', downloadForwardVideoUrl: null, gForce: 0.71 },
            }],
            pagination: { endCursor: null, hasNextPage: false },
          },
        },
        {
          // Same driver, same instant, different hardware and different vendor.
          tenantId, provider: 'lytx', fetchedAt: iso(),
          payload: {
            events: [{
              eventId: 'LYT-HB-' + driver.driverId,
              driverId: driver.driverId,
              vehicleId: driver.vehicleId,
              recordDateTime: at,
              latitude: driver.lat, longitude: driver.lon,
              behaviors: [{ id: 41, name: 'Braking - Hard', severity: 'High' }],
              triggerGForce: 0.68,
              status: 'Reviewed',
            }],
            meta: { count: 1 },
          },
        },
      ];
    },
  },

  {
    id: 'hos-risk',
    title: 'Hours-of-service running out, Chicago',
    proves: 'A regulatory clock is authoritative - it escalates without a second opinion',
    build(tenantId) {
      const driver = driversIn('chi')[0];
      return [{
        tenantId, provider: 'motive', fetchedAt: iso(),
        payload: {
          logs: [{
            log: {
              driver: { id: driver.driverId, username: driver.driverId },
              date: '2026-09-08',
              driving_time_remaining: 1_500,      // 25 minutes
              shift_time_remaining: 4_200,
              current_status: 'driving',
              updated_at: iso(),
            },
          }],
          pagination: { per_page: 100, page_no: 1, total: 1 },
        },
      }];
    },
  },

  {
    id: 'panic',
    title: 'Driver panic button, Phoenix',
    proves: 'The sub-second path: no batching window, no corroboration, no delay',
    build(tenantId) {
      const driver = driversIn('phx')[0];
      // Modelled as a Lytx event because the dashcam is what has a physical
      // button in the cab. A real deployment routes this off the batched
      // stream entirely - "real-time" for a 30-second position refresh and
      // "real-time" for a panic alert are different systems.
      return [{
        tenantId, provider: 'lytx', fetchedAt: iso(),
        payload: {
          events: [{
            eventId: 'LYT-PANIC-' + driver.driverId,
            driverId: driver.driverId,
            vehicleId: driver.vehicleId,
            recordDateTime: iso(),
            latitude: driver.lat, longitude: driver.lon,
            behaviors: [{ id: 99, name: 'Panic Button', severity: 'Critical' }],
            triggerGForce: 0,
            status: 'Unreviewed',
          }],
          meta: { count: 1 },
        },
      }];
    },
  },

  {
    id: 'poison-record',
    title: 'One unparseable payload mid-batch',
    proves: 'The batch is bisected, one record is parked, and the shard keeps moving',
    build(tenantId) {
      const fleet = driversIn('dal').slice(0, 8);
      return [{
        tenantId, provider: 'samsara', fetchedAt: iso(),
        payload: {
          data: fleet.map((d, i) => ({
            id: d.vehicleId, name: d.vehicleId,
            externalIds: { driverId: d.driverId },
            gps: {
              time: iso(i * 500),
              latitude: d.lat, longitude: d.lon,
              // The fifth vehicle reports a speed the vendor's own docs say is
              // impossible. A bad firmware rollout looks exactly like this.
              speedMilesPerHour: i === 4 ? Number.NaN : 55,
              headingDegrees: 90,
              reverseGeo: { formattedLocation: 'I-30 E, Dallas, TX' },
            },
            engineStates: { time: iso(i * 500), value: 'On' },
            harshEvent: null,
          })),
          pagination: { endCursor: null, hasNextPage: false },
        },
      }];
    },
  },
];

export function scenarioById(id: ScenarioId): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
