/**
 * One comms poll, end to end: workforce -> signals -> alarms -> incidents ->
 * store. What a scheduled Lambda per tenant would run.
 *
 * The Entra directory is synced by DELTA each poll - a handful of changed
 * users, not 75,000 - and the workforce is rebuilt from it. The roster itself
 * is rebuilt every time rather than cached: it is the only thing that turns a
 * call into a facility, and a stale one would charge a moved person's bad
 * calls to the building they left.
 */
import type { Principal } from '../../platform/types.ts';
import { nowIso } from '../../platform/clock.ts';
import { assertSameTenant } from '../../platform/tenancy.ts';
import type { CommsClient } from './client.ts';
import type { CommsTenantConfig } from './types.ts';
import { buildWorkforce, type WorkforceReport } from './workforce.ts';
import { loadEntraDirectory, syncEntraDirectory, type EntraSyncResult } from './entra-directory.ts';
import { collectSignals, type CommsSignal } from './signals.ts';
import { correlateAlarms, evaluateSignals, type CommsAlarm, type CommsIncident } from './incidents.ts';
import { putCommsRun, summariseWorkforce, type WorkforceSummary } from './store.ts';

export type CommsPollResult = {
  /** The full roster, for the caller's use in memory. Never persisted; see store.ts. */
  report: WorkforceReport;
  /** What this poll's directory sync did. Undefined when the tenant runs no Teams. */
  directorySync?: EntraSyncResult;
  workforce: WorkforceSummary;
  signals: CommsSignal[];
  alarms: CommsAlarm[];
  incidents: CommsIncident[];
};

export async function runCommsPoll(
  principal: Principal, client: CommsClient, config: CommsTenantConfig, at: number,
): Promise<CommsPollResult> {
  // The client carries its own tenant for the token cache; make sure it is
  // the principal's. A mismatch here would write tenant B's data under A.
  assertSameTenant(principal, client.tenantId);
  assertSameTenant(principal, config.tenantId);

  // The directory first: it is what places people, and its state is what
  // the workforce reports as complete or not.
  const directorySync = config.sources.includes('teams')
    ? await syncEntraDirectory(principal, client)
    : undefined;
  const report = await buildWorkforce(client, config, loadEntraDirectory(principal));
  const signals = await collectSignals(client, config, report, at);
  const alarms = evaluateSignals(signals);
  const incidents = correlateAlarms(alarms);
  const workforce = summariseWorkforce(report, nowIso());

  putCommsRun(principal, { workforce, alarms, incidents });
  return { report, directorySync, workforce, signals, alarms, incidents };
}
