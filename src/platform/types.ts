/**
 * ---------------------------------------------------------------------------
 * Meridian domain model
 * ---------------------------------------------------------------------------
 * The whole platform is an ingest + AI loop over one idea:
 *
 *   telematics API -> RawRecord -> Telemetry -> Exception -> Incident -> answer
 *
 * `Telemetry` is the *canonical* shape. Samsara, Motive and Lytx all speak
 * different dialects; every connector's job is to translate into `Telemetry` so
 * that the rest of the platform (GraphQL, the AI agent, the dispatch board)
 * only ever has to understand ONE schema.
 *
 * THE TWO-LEVEL SPLIT, and why it is not over-modelling:
 *
 *   Exception  one driver, one rule, decided deterministically.
 *              "Driver 42 is 800m off the planned corridor."
 *   Incident   many exceptions, corroborated and merged. This is what pages a
 *              human. "Road closure on I-35 affecting 14 drivers."
 *
 * Collapsing them means a road closure pages a dispatcher fourteen times, which
 * is how on-call teams learn to ignore the board. Keeping them apart is what
 * makes "corroborate before alerting" expressible at all.
 *
 * Note the `tenantId` on literally everything. In a multi-tenant platform the
 * tenant is not a filter you remember to add - it is part of the identity of
 * every record and the partition key of every query. See platform/tenancy.ts.
 */

/** Opaque-ish branded IDs keep you from passing a driverId where a tenantId goes. */
export type TenantId = string;
export type DriverId = string;
export type DistrictId = string;
export type TelemetryId = string;
export type ExceptionId = string;
export type IncidentId = string;

/**
 * The eight vendors, in three families.
 *
 * A real carrier does NOT run all eight - a truck carries one GPS unit, one
 * ELD and one dashcam. Which three a tenant actually uses is per-tenant
 * configuration; see integrations/registry.ts.
 */
export type ProviderId =
  // Telematics: GPS position, speed, engine and vehicle health.
  | 'samsara'
  | 'geotab'
  | 'verizon-connect'
  // ELD / hours-of-service: the regulated driving-time clock.
  | 'motive'
  | 'omnitracs'
  | 'platform-science'
  // Video safety: dashcam event detection.
  | 'lytx'
  | 'netradyne';

export type ProviderDomain = 'telematics' | 'eld-hos' | 'video-safety';

export type Severity = 'ok' | 'info' | 'warning' | 'critical';

/**
 * What a reading measures. Drives units, thresholds, and how the agent talks.
 *
 * Every kind is a SCALAR plus optional coordinates, because that keeps one
 * storage shape and one subscription payload for all eight vendors. What
 * `value` means per kind:
 *
 *   position         speed in kph      (the point itself is in `location`)
 *   speeding         kph over the posted limit
 *   harsh-brake      peak deceleration in g
 *   idle             consecutive minutes stationary with the engine running
 *   hos-remaining    minutes of legal drive time left
 *   route-adherence  metres from the planned route corridor
 *   geofence-state   1 inside, 0 outside  (which fence is in `attributes`)
 *   panic            1 - the driver pressed the button
 */
export type TelemetryKind =
  | 'position'
  | 'speeding'
  | 'harsh-brake'
  | 'idle'
  | 'hos-remaining'
  | 'route-adherence'
  | 'geofence-state'
  | 'panic';

export type Unit = 'kph' | 'g' | 'minutes' | 'metres' | 'percent' | 'count' | 'boolean';

/** Exactly what came back from the vendor, before we touched it. Lands in S3. */
export type RawRecord = {
  tenantId: TenantId;
  provider: ProviderId;
  fetchedAt: string;          // ISO-8601
  /** Vendor-native payload. Deliberately `unknown` - nobody may read it except
   *  that provider's own normalise() function. */
  payload: unknown;
};

/** The canonical reading. Everything downstream reads this and only this. */
export type Telemetry = {
  tenantId: TenantId;
  telemetryId: TelemetryId;
  provider: ProviderId;
  domain: ProviderDomain;
  kind: TelemetryKind;
  driverId: DriverId;
  /** Vendor's own id for the thing (device serial, vehicle id, event id). */
  sourceRef: string;
  value: number;
  unit: Unit;
  severity: Severity;
  observedAt: string;         // ISO-8601, from the device's clock
  /** Where the reading was taken. `district` is filled in by resolveTerritory. */
  location?: { lon: number; lat: number; district: DistrictId };
  attributes: Record<string, string | number | boolean>;
};

/** What a deterministic rule decided about ONE driver. Not yet a page. */
export type ExceptionKind =
  | 'geofence-breach'
  | 'harsh-braking'
  | 'route-deviation'
  | 'prolonged-idle'
  | 'hos-risk'
  | 'panic';

export type Exception = {
  tenantId: TenantId;
  exceptionId: ExceptionId;
  driverId: DriverId;
  districtId: DistrictId;
  kind: ExceptionKind;
  severity: Severity;
  /** The readings that triggered it - ideally from independent providers. */
  telemetryIds: TelemetryId[];
  /** Which vendors agreed. Two or more is the bar for raising an incident. */
  providers: ProviderId[];
  location: { lon: number; lat: number };
  /** The route corridor this happened on, when known. Drives the merge rule. */
  corridorId?: string;
  raisedAt: string;
};

/**
 * A corroborated cluster of exceptions. THIS is what humans get paged about.
 *
 * One road closure produces fourteen exceptions and exactly one incident.
 */
export type Incident = {
  tenantId: TenantId;
  incidentId: IncidentId;
  title: string;
  severity: Severity;
  status: 'open' | 'acknowledged' | 'resolved';
  districtId: DistrictId;
  driverIds: DriverId[];
  exceptionIds: ExceptionId[];
  openedAt: string;
  /** Written by the Bedrock agent, not by a human. */
  aiSummary?: string;
  aiCitations?: Array<{ source: string; snippet: string }>;
};

export type DriverStatus = 'driving' | 'stopped' | 'on-break' | 'off-duty';

/**
 * A driver and their vehicle. THE HOT STATE.
 *
 * One item per driver, overwritten on every position ping. At 330k drivers
 * that is 330k items regardless of how often devices report - which is the
 * whole reason position history lives in S3 instead of here.
 */
export type Driver = {
  tenantId: TenantId;
  driverId: DriverId;
  name: string;
  districtId: DistrictId;
  vehicleId: string;
  status: DriverStatus;
  /** Current position. Overwritten, never appended. */
  lon: number;
  lat: number;
  /** Minutes of legal drive time remaining. Drives the hos-risk rule. */
  hosRemainingMinutes: number;
  updatedAt: string;
};

/** A dispatch district. Lives in Aurora PostGIS; cached in DynamoDB. */
export type Territory = {
  tenantId: TenantId;
  districtId: DistrictId;
  name: string;
  region: string;
  /** The depot/yard drivers start and end at. */
  lon: number;
  lat: number;
};

/**
 * How much of the fleet a caller may see.
 *
 * A discriminated union rather than an optional `districtId`, precisely so that
 * a repository function cannot accidentally treat "no district" as "all
 * districts". Widening access has to be a deliberate `kind: 'tenant'`.
 */
export type Scope =
  | { kind: 'tenant' }                              // whole carrier - admins
  | { kind: 'region'; region: string }              // regional manager
  | { kind: 'district'; districtId: DistrictId }    // a dispatcher's board
  | { kind: 'driver'; driverId: DriverId };         // the driver's own app

/** The identity the rest of the code trusts, produced by verifying a JWT. */
export type Principal = {
  sub: string;
  email: string;
  tenantId: TenantId;
  /** Roles come from Cognito groups, mapped from SAML/OIDC claims upstream. */
  roles: Array<'admin' | 'dispatcher' | 'safety' | 'driver' | 'viewer'>;
  /** How much of the fleet this caller may see. Never a bare district id. */
  scope: Scope;
  /** Which IdP the user actually came from - useful for audit + debugging. */
  identityProvider: 'cognito' | 'Google' | 'Facebook' | 'SignInWithApple' | 'AcmeSAML' | 'OktaOIDC';
};
