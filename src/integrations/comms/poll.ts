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
import { attachHelixContext } from './helix-context.ts';
import { dataQuality, observeRun, recordHealth, type IntegrationHealth } from './health.ts';
import { errorLine, type SignalSource } from './types.ts';
import { reconcileIncidents } from './lifecycle.ts';
import { pullPhoneInventory, type PhoneInventory } from './kurmi.ts';
import { putPhoneInventory } from './store.ts';

export type CommsPollResult = {
  /** The full roster, for the caller's use in memory. Never persisted; see store.ts. */
  report: WorkforceReport;
  /** What this poll's directory sync did. Undefined when the tenant runs no Teams. */
  directorySync?: EntraSyncResult;
  workforce: WorkforceSummary;
  signals: CommsSignal[];
  alarms: CommsAlarm[];
  /** Every incident OPEN after this poll - continuing ones keep their id and opening time. */
  incidents: CommsIncident[];
  /** Incidents this poll resolved (measured healthy for enough consecutive polls). */
  resolved: CommsIncident[];
  /** Incident ids this poll reopened - the same problem back within the reopen window. */
  reopened: string[];
  /** The Cisco phone estate from Kurmi, when the tenant runs it and the pull succeeded. */
  phones?: PhoneInventory;
  /** Per-source health and data quality, as recorded by this poll. */
  health: IntegrationHealth;
};

export async function runCommsPoll(
  principal: Principal, client: CommsClient, config: CommsTenantConfig, at: number,
): Promise<CommsPollResult> {
  // The client carries its own tenant for the token cache; make sure it is
  // the principal's. A mismatch here would write tenant B's data under A.
  assertSameTenant(principal, client.tenantId);
  assertSameTenant(principal, config.tenantId);

  // EVERY STEP BELOW SURVIVES ANY ONE SOURCE FAILING. A failure is recorded
  // against that source - in the health view, and in the reason an alarm was
  // held back - and the poll carries on with the rest.

  // The directory first: it is what places people, and its state is what
  // the workforce reports as complete or not. If the sync fails, the last
  // committed copy is still there to read.
  let directorySync: EntraSyncResult | undefined;
  let directoryError: string | undefined;
  if (config.sources.includes('teams')) {
    try { directorySync = await syncEntraDirectory(principal, client); } catch (err) { directoryError = errorLine(err); }
  }
  const report = await buildWorkforce(client, config, loadEntraDirectory(principal));
  const collected = await collectSignals(client, config, report, at);
  const alarms = evaluateSignals(collected.signals, {
    unavailable: Object.keys(collected.errors) as SignalSource[],
  });
  // Context AFTER the rules have decided: Helix can explain an incident, it
  // cannot create or suppress one.
  const unavailable = Object.keys(collected.errors) as SignalSource[];
  const helix = await attachHelixContext(client, config, correlateAlarms(alarms), at);
  // Continuity: this window's incidents folded into the open set. Resolution
  // needs a HEALTHY MEASUREMENT - see lifecycle.ts - so the signals and the
  // unavailable sources go in, not just the incidents.
  const lifecycle = reconcileIncidents(principal, at, helix.incidents, collected.signals, unavailable);
  const incidents = lifecycle.open;
  const workforce = summariseWorkforce(report, nowIso());

  // Kurmi: the Cisco phones. Independent of everything above - devices, not
  // people - and isolated like every other source.
  let phones: PhoneInventory | undefined;
  let kurmiError: string | undefined;
  if (config.kurmi) {
    try {
      phones = await pullPhoneInventory(client, config, nowIso());
      putPhoneInventory(principal, phones);
    } catch (err) {
      kurmiError = errorLine(err);
    }
  }

  const health = recordHealth(principal, at, observeRun({
    config, directorySync, directoryError, report,
    signalErrors: collected.errors, helixError: helix.error, kurmiError, phones,
  }), dataQuality(report, collected.unmappedBandwidthPeers, phones));

  putCommsRun(principal, { workforce, alarms });
  return {
    report, directorySync, workforce, signals: collected.signals, alarms, incidents,
    resolved: lifecycle.resolved, reopened: lifecycle.reopened, phones, health,
  };
}
