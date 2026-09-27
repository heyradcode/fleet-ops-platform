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
import type {
  Alarm, DeviceState, Incident, Observation, Principal, Severity,
} from './types.ts';

// ---------------------------------------------------------------------------
// Devices - THE HOT STATE
// ---------------------------------------------------------------------------

/**
 * Overwrite one device's current condition.
 *
 * This is the write that happens on every observation, and the reason it stays
 * affordable is that it OVERWRITES. The item count is bounded by the number of
 * devices, not by the number of syslog lines. History goes to S3 via
 * appendHistory() instead - see pipeline/steps.ts.
 */
export async function putDeviceState(principal: Principal, device: DeviceState): Promise<void> {
  await mainTable.put({
    ...keys.device(principal, device.deviceId),
    ...keys.deviceBySite(principal, device.siteId, device.deviceId),
    entity: 'DeviceState',
    ...device,
  });
}

export async function putDeviceStates(principal: Principal, devices: DeviceState[]): Promise<void> {
  await mainTable.batchPut(devices.map((d) => ({
    ...keys.device(principal, d.deviceId),
    ...keys.deviceBySite(principal, d.siteId, d.deviceId),
    entity: 'DeviceState',
    ...d,
  })));
}

/**
 * "Every device at this site" - one Query on GSI1.
 *
 * This is the operations board's first load. Without the GSI you would read the
 * whole estate and filter, which costs read units proportional to your data
 * rather than to your answer - the difference between one site and forty
 * thousand devices.
 */
export async function devicesAtSite(principal: Principal, siteId: string): Promise<DeviceState[]> {
  return (await mainTable
    .query({ index: 'GSI1', pk: 'TENANT#' + principal.tenantId + '#SITE#' + siteId }))
    .map(strip<DeviceState>);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export async function putObservations(principal: Principal, observations: Observation[]): Promise<void> {
  const items: Item[] = observations.map((o) => ({
    ...keys.observation(principal, o.observedAt, o.observationId),
    ...keys.observationByDevice(principal, o.deviceId, o.observedAt),
    entity: 'Observation',
    ...o,
  }));
  await mainTable.batchPut(items);
}

/** "Newest N observations for this tenant" - one Query, descending, limited. */
export async function recentObservations(principal: Principal, limit = 25): Promise<Observation[]> {
  return (await mainTable
    .query({ pk: 'TENANT#' + principal.tenantId + '#OBSERVATION', scanIndexForward: false, limit }))
    .map(strip<Observation>);
}

/**
 * "Everything seen about one device" - this is what GSI1 is for. It is also the
 * query the agent runs when an operator asks why a site went quiet.
 *
 * Note that this crosses PLANES as well as feeds: the device's own syslog, the
 * controller's opinion of it, and our probe all come back together, which is
 * exactly what makes the corroboration story legible to a human reading it.
 */
export async function observationsForDevice(
  principal: Principal,
  deviceId: string,
  sinceIso?: string,
): Promise<Observation[]> {
  return (await mainTable.query({
    index: 'GSI1',
    pk: 'TENANT#' + principal.tenantId + '#DEVICE#' + deviceId,
    skBetween: sinceIso ? [sinceIso, '9999'] : undefined,
    scanIndexForward: false,
  })).map(strip<Observation>);
}

export async function observationsBySeverity(principal: Principal, severity: Severity): Promise<Observation[]> {
  // A filter, applied after the Query. Filters do NOT reduce read cost - the
  // items are read and then discarded. Fine for a small partition; if this were
  // hot, severity would belong in a sort key or a sparse GSI instead.
  return (await recentObservations(principal, 500)).filter((o) => o.severity === severity);
}

// ---------------------------------------------------------------------------
// Alarms and incidents
// ---------------------------------------------------------------------------

export async function putAlarms(principal: Principal, alarms: Alarm[]): Promise<void> {
  await mainTable.batchPut(alarms.map((a) => ({
    ...keys.alarm(principal, a.raisedAt, a.alarmId),
    entity: 'Alarm',
    ...a,
  })));
}

export async function recentAlarms(principal: Principal, limit = 50): Promise<Alarm[]> {
  return (await mainTable
    .query({ pk: 'TENANT#' + principal.tenantId + '#ALARM', scanIndexForward: false, limit }))
    .map(strip<Alarm>);
}

export async function putIncident(principal: Principal, incident: Incident): Promise<void> {
  await mainTable.put({
    ...keys.incident(principal, incident.openedAt, incident.incidentId),
    entity: 'Incident',
    ...incident,
  });
}

export async function openIncidents(principal: Principal, limit = 25): Promise<Incident[]> {
  return (await mainTable
    .query({ pk: 'TENANT#' + principal.tenantId + '#INCIDENT', scanIndexForward: false, limit }))
    .map(strip<Incident>)
    .filter((i) => i.status !== 'resolved');
}

export async function getIncident(principal: Principal, incidentId: string): Promise<Incident | undefined> {
  return (await mainTable
    .query({ pk: 'TENANT#' + principal.tenantId + '#INCIDENT' }))
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
