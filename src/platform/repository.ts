/**
 * The data-access layer. Every read and write to DynamoDB goes through here.
 *
 * Two reasons this file exists rather than scattering `table.query(...)` calls
 * through the resolvers:
 *
 *   1. Tenancy. Every function takes a `Principal` and builds the partition key
 *      from it. There is no code path that can query without a tenant, because
 *      there is no function that accepts a bare tenantId.
 *   2. Key layout. When the access patterns change - and they will - the key
 *      design changes in one file instead of thirty.
 *
 * GraphQL resolvers, REST handlers, the ingest pipeline and the AI agent's
 * tools all call these same functions. That is deliberate: the agent must not
 * have a privileged back door into the data.
 */
import { keys, mainTable, type Item } from '../aws/dynamodb.ts';
import type { Driver, Exception, Incident, Principal, Severity, Telemetry } from './types.ts';

// ---------------------------------------------------------------------------
// Drivers - THE HOT STATE
// ---------------------------------------------------------------------------

/**
 * Overwrite one driver's current position and status.
 *
 * This is the write that happens 11,000 times a second at full fleet scale, and
 * the reason it stays affordable is that it OVERWRITES. The item count is
 * bounded by the number of drivers, not by the number of pings. History goes to
 * S3 via appendHistory() instead - see pipeline/steps.ts.
 */
export function putDriver(principal: Principal, driver: Driver): void {
  mainTable.put({
    ...keys.driver(principal, driver.driverId),
    ...keys.driverByDistrict(principal, driver.districtId, driver.driverId),
    entity: 'Driver',
    ...driver,
  });
}

export function putDrivers(principal: Principal, drivers: Driver[]): void {
  mainTable.batchPut(drivers.map((d) => ({
    ...keys.driver(principal, d.driverId),
    ...keys.driverByDistrict(principal, d.districtId, d.driverId),
    entity: 'Driver',
    ...d,
  })));
}

/**
 * "Every driver in this district" - one Query on GSI1.
 *
 * This is the dispatch board's first load. Without the GSI you would read the
 * whole fleet and filter, which costs read units proportional to your data
 * rather than to your answer - the difference between one district and 330,000
 * drivers.
 */
export function driversInDistrict(principal: Principal, districtId: string): Driver[] {
  return mainTable
    .query({ index: 'GSI1', pk: 'TENANT#' + principal.tenantId + '#DISTRICT#' + districtId })
    .map(strip<Driver>);
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export function putTelemetry(principal: Principal, readings: Telemetry[]): void {
  const items: Item[] = readings.map((t) => ({
    ...keys.telemetry(principal, t.observedAt, t.telemetryId),
    ...keys.telemetryByDriver(principal, t.driverId, t.observedAt),
    entity: 'Telemetry',
    ...t,
  }));
  mainTable.batchPut(items);
}

/** "Newest N readings for this tenant" - one Query, descending, limited. */
export function recentTelemetry(principal: Principal, limit = 25): Telemetry[] {
  return mainTable
    .query({ pk: 'TENANT#' + principal.tenantId + '#TELEMETRY', scanIndexForward: false, limit })
    .map(strip<Telemetry>);
}

/**
 * "All readings for one driver" - this is what GSI1 is for. It is also the
 * query the agent runs when a dispatcher asks why a driver is behind.
 */
export function telemetryForDriver(
  principal: Principal,
  driverId: string,
  sinceIso?: string,
): Telemetry[] {
  return mainTable.query({
    index: 'GSI1',
    pk: 'TENANT#' + principal.tenantId + '#DRIVER#' + driverId,
    skBetween: sinceIso ? [sinceIso, '9999'] : undefined,
    scanIndexForward: false,
  }).map(strip<Telemetry>);
}

export function telemetryBySeverity(principal: Principal, severity: Severity): Telemetry[] {
  // A filter, applied after the Query. Filters do NOT reduce read cost - the
  // items are read and then discarded. Fine for a small partition; if this were
  // hot, severity would belong in a sort key or a sparse GSI instead.
  return recentTelemetry(principal, 500).filter((t) => t.severity === severity);
}

// ---------------------------------------------------------------------------
// Exceptions and incidents
// ---------------------------------------------------------------------------

export function putExceptions(principal: Principal, exceptions: Exception[]): void {
  mainTable.batchPut(exceptions.map((e) => ({
    ...keys.exception(principal, e.raisedAt, e.exceptionId),
    entity: 'Exception',
    ...e,
  })));
}

export function recentExceptions(principal: Principal, limit = 50): Exception[] {
  return mainTable
    .query({ pk: 'TENANT#' + principal.tenantId + '#EXCEPTION', scanIndexForward: false, limit })
    .map(strip<Exception>);
}

export function putIncident(principal: Principal, incident: Incident): void {
  mainTable.put({
    ...keys.incident(principal, incident.openedAt, incident.incidentId),
    entity: 'Incident',
    ...incident,
  });
}

export function openIncidents(principal: Principal, limit = 25): Incident[] {
  return mainTable
    .query({ pk: 'TENANT#' + principal.tenantId + '#INCIDENT', scanIndexForward: false, limit })
    .map(strip<Incident>)
    .filter((i) => i.status !== 'resolved');
}

export function getIncident(principal: Principal, incidentId: string): Incident | undefined {
  return mainTable
    .query({ pk: 'TENANT#' + principal.tenantId + '#INCIDENT' })
    .map(strip<Incident>)
    .find((i) => i.incidentId === incidentId);
}

// ---------------------------------------------------------------------------

/**
 * Items come back with PK/SK/GSI1PK/GSI1SK attached. Strip them at the
 * boundary so nothing outside this file learns the key layout.
 */
function strip<T>(item: Item): T {
  const { PK, SK, GSI1PK, GSI1SK, entity, ...rest } = item;
  return rest as unknown as T;
}
