/**
 * One comms poll, end to end: workforce -> signals -> alarms -> incidents ->
 * store. What a scheduled Lambda per tenant would run.
 *
 * The workforce is rebuilt every time rather than cached between polls. It is
 * the expensive half, and in production it should move to its own, slower
 * schedule on Graph's delta query - but it is also the only thing that turns a
 * call into a facility, and a stale roster would charge a moved person's bad
 * calls to the building they left.
 */
import type { Principal } from '../../platform/types.ts';
import { nowIso } from '../../platform/clock.ts';
import { assertSameTenant } from '../../platform/tenancy.ts';
import type { CommsClient } from './client.ts';
import type { CommsTenantConfig } from './types.ts';
import { buildWorkforce, type WorkforceReport } from './workforce.ts';
import { collectSignals, type CommsSignal } from './signals.ts';
import { correlateAlarms, evaluateSignals, type CommsAlarm, type CommsIncident } from './incidents.ts';
import { putCommsRun, summariseWorkforce, type WorkforceSummary } from './store.ts';

export type CommsPollResult = {
  /** The full roster, for the caller's use in memory. Never persisted; see store.ts. */
  report: WorkforceReport;
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

  const report = await buildWorkforce(client, config);
  const signals = await collectSignals(client, config, report, at);
  const alarms = evaluateSignals(signals);
  const incidents = correlateAlarms(alarms);
  const workforce = summariseWorkforce(report, nowIso());

  putCommsRun(principal, { workforce, alarms, incidents });
  return { report, workforce, signals, alarms, incidents };
}
