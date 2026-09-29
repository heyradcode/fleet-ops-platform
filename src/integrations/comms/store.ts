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
import type { PhoneInventory } from './kurmi.ts';
import type { QueueStaffing, StaffingSnapshot } from './staffing.ts';
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
export async function putCommsRun(principal: Principal, run: {
  workforce: WorkforceSummary;
  alarms: CommsAlarm[];
}): Promise<void> {
  await mainTable.put({ PK: pk(principal, 'COMMS'), SK: 'WORKFORCE#LATEST', entity: 'CommsWorkforce', ...run.workforce });
  await mainTable.batchPut(run.alarms.map((a) => ({
    PK: pk(principal, 'COMMSALARM'), SK: a.raisedAt + '#' + a.alarmId, entity: 'CommsAlarm', ...a,
  })));
}

export async function commsWorkforce(principal: Principal): Promise<WorkforceSummary | undefined> {
  requireTenantScope(principal);
  const item = await mainTable.get(pk(principal, 'COMMS'), 'WORKFORCE#LATEST');
  return item ? strip<WorkforceSummary>(item) : undefined;
}

/** The Cisco phone inventory: counts only, overwritten each poll. */
export async function putPhoneInventory(principal: Principal, inventory: PhoneInventory): Promise<void> {
  await mainTable.put({ PK: pk(principal, 'COMMS'), SK: 'PHONES#LATEST', entity: 'PhoneInventory', ...inventory });
}

export async function commsPhones(principal: Principal): Promise<PhoneInventory | undefined> {
  requireTenantScope(principal);
  const item = await mainTable.get(pk(principal, 'COMMS'), 'PHONES#LATEST');
  return item ? strip<PhoneInventory>(item) : undefined;
}

const STAFFING_QUEUE = 'STAFFING#Q#';
const STAFFING_META = 'STAFFING#META';

/**
 * Queue staffing: COUNTS per queue per building. The roster it came from is
 * not stored.
 *
 * ONE ITEM PER QUEUE, not one snapshot. A whole contact centre in one item -
 * hundreds of queues, each staffed from dozens of buildings - passes every
 * test and then fails at DynamoDB's 400 KB item limit on the first real
 * tenant. The header carries `asOf`, the freshness watermark, so it is written
 * AFTER the queues it describes, and a queue the snapshot no longer has is
 * deleted after THAT: write first, delete last. A crash between leaves an old
 * header, and the next poll simply refreshes.
 */
export async function putQueueStaffing(principal: Principal, staffing: StaffingSnapshot): Promise<void> {
  const key = pk(principal, 'COMMS');
  await mainTable.batchPut(staffing.queues.map((q) => ({ PK: key, SK: STAFFING_QUEUE + q.queueId, entity: 'QueueStaffing', ...q })));
  await mainTable.put({ PK: key, SK: STAFFING_META, entity: 'QueueStaffingMeta', asOf: staffing.asOf, queues: staffing.queues.length });
  const keep = new Set(staffing.queues.map((q) => STAFFING_QUEUE + q.queueId));
  for (const row of await mainTable.query({ pk: key, skBeginsWith: STAFFING_QUEUE })) {
    if (!keep.has(String(row.SK))) await mainTable.delete(row.PK, row.SK);
  }
}

export async function commsQueueStaffing(principal: Principal): Promise<StaffingSnapshot | undefined> {
  requireTenantScope(principal);
  const key = pk(principal, 'COMMS');
  const meta = await mainTable.get(key, STAFFING_META);
  if (!meta) return undefined;
  const queues = (await mainTable.query({ pk: key, skBeginsWith: STAFFING_QUEUE })).map((r) => strip<QueueStaffing>(r));
  return {
    asOf: String(meta.asOf),
    queues: queues.sort((a, b) => a.queueName.localeCompare(b.queueName) || a.queueId.localeCompare(b.queueId)),
  };
}

/** The OPEN incidents - one per subject that is currently a problem. */
export async function commsIncidents(principal: Principal): Promise<CommsIncident[]> {
  requireTenantScope(principal);
  return openCommsIncidents(principal);
}

/** Recently resolved, newest first. */
export async function commsResolvedIncidents(principal: Principal, limit = 10): Promise<CommsIncident[]> {
  requireTenantScope(principal);
  return resolvedCommsIncidents(principal, limit);
}

export async function commsAlarms(principal: Principal, limit = 50): Promise<CommsAlarm[]> {
  requireTenantScope(principal);
  return (await mainTable.query({ pk: pk(principal, 'COMMSALARM'), scanIndexForward: false, limit })).map(strip<CommsAlarm>);
}

function strip<T>(item: Record<string, unknown>): T {
  const { PK, SK, GSI1PK, GSI1SK, entity, ...rest } = item;
  return rest as unknown as T;
}
