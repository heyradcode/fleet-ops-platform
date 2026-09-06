/**
 * Canned vendor responses, shaped like the real APIs.
 *
 * PROVENANCE - this matters, so it is stated rather than implied:
 * every shape below is **modelled from the vendor's published API reference**,
 * not captured from a live account. Samsara, Motive, Lytx, Netradyne, Omnitracs
 * and Platform Science all gate API access behind a customer contract, so an
 * individual developer cannot obtain a sandbox. Field names, envelope shapes
 * and units follow the public documentation; the values are synthetic.
 *
 * If you ever DO get real access, the right move is to capture one true
 * response per vendor, commit it, and assert the Telemetry it produces. That
 * test catches the day a vendor renames a field - which they will, without
 * telling you.
 *
 * Notice how different the eight shapes are: REST collections with pagination,
 * an RPC-style `result` envelope, PascalCase records, nested behaviour arrays.
 * That difference is the entire justification for the normalisation layer.
 *
 * The data is deliberately CORROBORATING. Driver drv-0142 brakes hard at the
 * same instant in both the Samsara telematics feed and the Lytx dashcam feed -
 * two independent devices, one event. That is what `detectIncidents` is looking
 * for, and a single feed could never establish it.
 */

/** The instant every fixture is pinned to. Matches platform/clock.ts DEMO_EPOCH. */
const T = '2026-09-08T14:30:00.000Z';
const T_MINUS_1M = '2026-09-08T14:29:00.000Z';

// ---------------------------------------------------------------------------
// Telematics - GPS, speed, engine
// ---------------------------------------------------------------------------

/** Samsara - GET /fleet/vehicles/stats?types=gps,engineStates */
export const samsaraVehicleStats = {
  data: [
    {
      id: '281474977428999',
      name: 'TRK-8891',
      externalIds: { driverId: 'drv-0142' },
      gps: {
        time: T, latitude: 32.7767, longitude: -96.7970,
        speedMilesPerHour: 41.6, headingDegrees: 187,
        reverseGeo: { formattedLocation: 'I-35E S, Dallas, TX' },
      },
      engineStates: { time: T, value: 'On' },
      idleMinutes: 0,
      // Samsara reports harsh events on the vehicle stats feed as well as via
      // webhooks. This is the same physical event Lytx also sees.
      harshEvent: { time: T, behaviourLabel: 'Harsh Braking', downloadForwardVideoUrl: null, gForce: 0.62 },
    },
    {
      id: '281474977429004',
      name: 'TRK-8892',
      externalIds: { driverId: 'drv-0187' },
      gps: {
        time: T, latitude: 30.2672, longitude: -97.7431,
        speedMilesPerHour: 0, headingDegrees: 0,
        reverseGeo: { formattedLocation: 'Depot, Austin, TX' },
      },
      engineStates: { time: T, value: 'Idle' },
      idleMinutes: 23,
      harshEvent: null,
    },
  ],
  pagination: { endCursor: 'MjAyNi0wOS0wOA', hasNextPage: false },
};

/** Geotab - POST /apiv1 { method: "Get", typeName: "DeviceStatusInfo" } */
export const geotabDeviceStatusInfo = {
  result: [
    {
      device: { id: 'b27', serialNumber: 'G9-000-111-222' },
      driver: { id: 'drv-0311', name: 'Driver 0311' },
      dateTime: T,
      latitude: 39.7392, longitude: -104.9903,
      speed: 88,                       // km/h - Geotab is metric, Samsara is not
      isDeviceCommunicating: true,
      currentStateDuration: '00:04:12',
    },
  ],
  jsonrpc: '2.0',
};

/** Verizon Connect Reveal - GET /rad/v1/vehicles/status  (PascalCase records) */
export const verizonConnectVehicles = {
  Items: [
    {
      VehicleNumber: 'VZ-4410',
      DriverNumber: 'drv-0455',
      UpdateUTC: T,
      Latitude: 41.8781, Longitude: -87.6298,
      Speed: 52, SpeedLimit: 40,       // 12 km/h over
      Address: { City: 'Chicago', State: 'IL' },
    },
  ],
  TotalCount: 1,
};

// ---------------------------------------------------------------------------
// ELD / hours-of-service - the regulated driving clock
// ---------------------------------------------------------------------------

/** Motive (formerly KeepTruckin) - GET /v1/hours_of_service_logs */
export const motiveHosLogs = {
  logs: [
    {
      log: {
        driver: { id: 'drv-0142', username: 'd.0142' },
        date: '2026-09-08',
        // Motive reports the clock in seconds remaining.
        driving_time_remaining: 2_040,   // 34 minutes - close to the limit
        shift_time_remaining: 7_200,
        current_status: 'driving',
        updated_at: T,
      },
    },
    {
      log: {
        driver: { id: 'drv-0187', username: 'd.0187' },
        date: '2026-09-08',
        driving_time_remaining: 19_800,  // 5.5h - comfortable
        shift_time_remaining: 28_800,
        current_status: 'on_duty_not_driving',
        updated_at: T,
      },
    },
  ],
  pagination: { per_page: 100, page_no: 1, total: 2 },
};

/** Omnitracs (Solera) - GET /hos/v2/driverLogs */
export const omnitracsHos = {
  hosData: [
    {
      driverId: 'drv-0311',
      dutyStatus: 'D',
      // Omnitracs reports MINUTES, not seconds. Same concept, different unit -
      // exactly the sort of thing normalise() exists to absorb.
      minutesUntilBreakRequired: 25,
      minutesDrivingRemaining: 45,
      timestampUtc: T,
    },
  ],
};

/** Platform Science - GET /api/v2/duty-status */
export const platformScienceDuty = {
  duty_status: [
    {
      driver_ref: 'drv-0455',
      status: 'ON_DUTY_DRIVING',
      remaining_drive_minutes: 310,
      remaining_duty_minutes: 480,
      recorded_at: T,
    },
  ],
};

// ---------------------------------------------------------------------------
// Video safety - dashcam event detection
// ---------------------------------------------------------------------------

/**
 * Lytx - GET /video/v2/events
 *
 * Note `drv-0142` at time T: the SAME harsh-braking event Samsara reported.
 * Two independent devices, one physical event. That agreement is what lets
 * detectIncidents raise a safety exception instead of dismissing a sensor
 * glitch.
 */
export const lytxEvents = {
  events: [
    {
      eventId: 'LYT-99120',
      driverId: 'drv-0142',
      vehicleId: 'TRK-8891',
      recordDateTime: T,
      latitude: 32.7767, longitude: -96.7970,
      behaviors: [
        { id: 41, name: 'Braking - Hard', severity: 'High' },
        { id: 12, name: 'Following Distance', severity: 'Low' },
      ] as Array<{ id: number; name: string; severity: string }>,
      // Lytx reports peak g-force on the trigger.
      triggerGForce: 0.59,
      status: 'Reviewed',
    },
  ],
  meta: { count: 1 },
};

/** Netradyne Driveri - GET /v1/alerts */
export const netradyneAlerts = {
  alerts: [
    {
      alertId: 'ND-55021',
      driverIdentifier: 'drv-0187',
      alertType: 'PROLONGED_IDLE',
      // Netradyne sends epoch millis, not ISO strings.
      alertTimeMs: Date.parse(T_MINUS_1M),
      gps: { lat: 30.2672, lon: -97.7431 },
      durationSeconds: 1_380,          // 23 minutes idling
      severity: 'MEDIUM',
    },
  ],
};

// ---------------------------------------------------------------------------
// Chaos: let the demo show the retry and circuit breaker doing something
// ---------------------------------------------------------------------------

export const chaos = { failuresRemaining: 0 };

export function maybeFail(provider: string): void {
  if (chaos.failuresRemaining > 0) {
    chaos.failuresRemaining--;
    const err = new Error('upstream 503 from ' + provider);
    (err as Error & { status?: number }).status = 503;
    throw err;
  }
}
