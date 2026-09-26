/**
 * ---------------------------------------------------------------------------
 * Comms results in the operational store
 * ---------------------------------------------------------------------------
 * Same table, same discipline as platform/repository.ts: every function takes
 * a `Principal` and builds the key from it, so there is no way to read another
 * tenant's comms data by passing the wrong id.
 *
 * AGGREGATES ONLY. The workforce join produces a roster - named people, their
 * agency, the building they sit in - and that is personal data this platform
 * has no operational need to keep. What is stored is the split (counts per
 * agency, per facility, per unplaced reason), the alarms and the incidents.
 * The roster is rebuilt from the sources on every poll and never persisted,
 * so there is nothing to breach, retain or answer a records request about.
 *
 * TENANT SCOPE ONLY, for now. A network operator's scope is a SITE, and
 * comms subjects are facilities, trunks and queues - none of which is a site.
 * Mapping one onto the other by guesswork would be the "no site means all
 * sites" mistake the `Scope` union exists to prevent. Until there is an
 * agency or facility scope, comms data is visible to tenant-wide principals
 * and nobody else: widening access is a deliberate grant.
 */
import { mainTable } from '../../aws/dynamodb.ts';
import { pk, OutOfScopeError } from '../../platform/tenancy.ts';
import type { Principal } from '../../platform/types.ts';
import type { CommsAlarm, CommsIncident } from './incidents.ts';
import type { UnplacedReason } from './types.ts';
import { commsConfigFor } from './config.ts';
import { openCommsIncidents, resolvedCommsIncidents } from './lifecycle.ts';
import type { WorkforceReport } from './workforce.ts';

/** The workforce split, with every person-level field removed. */
export type WorkforceSummary = {
  asOf: string;
  byPlatform: WorkforceReport['byPlatform'];
  byFacility: WorkforceReport['byFacility'];
  unplacedByReason: Partial<Record<UnplacedReason, number>>;
  facilityConflicts: number;
  unmappedWebexLocations: string[];
  truncated: boolean;
  /** Placement is only as complete as this. */
  directory: WorkforceReport['directory'];
};

export function summariseWorkforce(report: WorkforceReport, asOf: string): WorkforceSummary {
  const unplacedByReason: WorkforceSummary['unplacedByReason'] = {};
  for (const u of report.unplaced) unplacedByReason[u.reason] = (unplacedByReason[u.reason] ?? 0) + 1;
  return {
    asOf,
    byPlatform: report.byPlatform,
    byFacility: report.byFacility,
    unplacedByReason,
    facilityConflicts: report.facilityConflicts.length,
    // Location NAMES are an admin's labels, not personal data, and are the
    // actionable part: someone has to add them to the table.
    unmappedWebexLocations: report.unmappedWebexLocations,
    truncated: Object.values(report.fetched).some((f) => f?.truncated),
    directory: report.directory,
  };
}

/**
 * Whether this caller gets comms at all: their tenant runs comms sources and
 * their scope is tenant-wide. The ONE definition, used by the agent's tool
 * list and by the board, so the two cannot disagree about who sees what.
 */
export function commsVisibleTo(principal: Principal): boolean {
  const config = commsConfigFor(principal.tenantId);
  return !!config && config.sources.length > 0 && principal.scope.kind === 'tenant';
}

export function requireTenantScope(principal: Principal): void {
  if (principal.scope.kind !== 'tenant') {
    throw new OutOfScopeError('comms data (needs tenant-wide scope; this caller has ' + principal.scope.kind + ' scope)');
  }
}

/** Incidents are NOT written here - lifecycle.ts owns them, one open record per subject. */
export function putCommsRun(principal: Principal, run: {
  workforce: WorkforceSummary;
  alarms: CommsAlarm[];
}): void {
  mainTable.put({ PK: pk(principal, 'COMMS'), SK: 'WORKFORCE#LATEST', entity: 'CommsWorkforce', ...run.workforce });
  mainTable.batchPut(run.alarms.map((a) => ({
    PK: pk(principal, 'COMMSALARM'), SK: a.raisedAt + '#' + a.alarmId, entity: 'CommsAlarm', ...a,
  })));
}

export function commsWorkforce(principal: Principal): WorkforceSummary | undefined {
  requireTenantScope(principal);
  const item = mainTable.query({ pk: pk(principal, 'COMMS') }).find((i) => i.SK === 'WORKFORCE#LATEST');
  return item ? strip<WorkforceSummary>(item) : undefined;
}

/** The OPEN incidents - one per subject that is currently a problem. */
export function commsIncidents(principal: Principal): CommsIncident[] {
  requireTenantScope(principal);
  return openCommsIncidents(principal);
}

/** Recently resolved, newest first. */
export function commsResolvedIncidents(principal: Principal, limit = 10): CommsIncident[] {
  requireTenantScope(principal);
  return resolvedCommsIncidents(principal, limit);
}

export function commsAlarms(principal: Principal, limit = 50): CommsAlarm[] {
  requireTenantScope(principal);
  return mainTable.query({ pk: pk(principal, 'COMMSALARM'), scanIndexForward: false, limit }).map(strip<CommsAlarm>);
}

function strip<T>(item: Record<string, unknown>): T {
  const { PK, SK, GSI1PK, GSI1SK, entity, ...rest } = item;
  return rest as unknown as T;
}
