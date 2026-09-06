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
import type { Incident, Principal, Signal } from './types.ts';

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export function putSignals(principal: Principal, signals: Signal[]): void {
  const items: Item[] = signals.map((s) => ({
    ...keys.signal(principal, s.observedAt, s.signalId),
    ...keys.signalBySite(principal, s.siteId, s.observedAt),
    entity: 'Signal',
    ...s,
  }));
  mainTable.batchPut(items);
}

/** "Newest N signals for this tenant" - one Query, descending, limited. */
export function recentSignals(principal: Principal, limit = 25): Signal[] {
  return mainTable
    .query({ pk: 'TENANT#' + principal.tenantId + '#SIGNAL', scanIndexForward: false, limit })
    .map(toSignal);
}

/**
 * "All signals for one site" - this is what GSI1 is for. Without it you would
 * have to read every signal for the tenant and filter, which costs read units
 * proportional to your data rather than to your answer.
 */
export function signalsForSite(principal: Principal, siteId: string, sinceIso?: string): Signal[] {
  const rows = mainTable.query({
    index: 'GSI1',
    pk: 'TENANT#' + principal.tenantId + '#SITE#' + siteId,
    skBetween: sinceIso ? [sinceIso, '9999'] : undefined,
    scanIndexForward: false,
  });
  return rows.map(toSignal);
}

export function signalsBySeverity(principal: Principal, severity: Signal['severity']): Signal[] {
  // A filter, applied after the Query. Filters do NOT reduce read cost - the
  // items are read and then discarded. Fine for a small partition; if this were
  // hot, severity would belong in a sort key or a sparse GSI instead.
  return recentSignals(principal, 500).filter((s) => s.severity === severity);
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

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
    .map(toIncident)
    .filter((i) => i.status !== 'resolved');
}

export function getIncident(principal: Principal, incidentId: string): Incident | undefined {
  return mainTable
    .query({ pk: 'TENANT#' + principal.tenantId + '#INCIDENT' })
    .map(toIncident)
    .find((i) => i.incidentId === incidentId);
}

// ---------------------------------------------------------------------------

/**
 * Items come back with PK/SK/GSI1PK/GSI1SK attached. Strip them at the
 * boundary so nothing outside this file learns the key layout.
 */
function toSignal(item: Item): Signal {
  const { PK, SK, GSI1PK, GSI1SK, entity, ...rest } = item;
  return rest as unknown as Signal;
}

function toIncident(item: Item): Incident {
  const { PK, SK, GSI1PK, GSI1SK, entity, ...rest } = item;
  return rest as unknown as Incident;
}
