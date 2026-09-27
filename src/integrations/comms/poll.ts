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
import { backfillBaselines, detectAndLearn, metricsFromSignals, putAnomalies, type BackfillProgress, type CommsAnomaly } from './anomalies.ts';

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
  /** Unusual for this subject at this hour of the week. Never alarms; see anomalies.ts. */
  anomalies: CommsAnomaly[];
  /** Per-source health and data quality, as recorded by this poll. */
  health: IntegrationHealth;
};

/**
 * Seed the anomaly baselines from `weeks` past weeks of the same hour.
 *
 * `history` wraps the signal read for a past time. In production it is the
 * identity: the vendors answer for past windows. The offline mocks serve only
 * RECENT activity, so the demo, board and tests pass `mockHistory` (in the
 * mock harness), which moves the injected clock back first. Needs the
 * workforce, because facility signals are attributed through it.
 */
export async function backfillCommsBaselines(
  principal: Principal, client: CommsClient, config: CommsTenantConfig, at: number, weeks: number,
  history: (read: (at: number) => Promise<CommsSignal[]>) => (at: number) => Promise<CommsSignal[]> = (r) => r,
  progress: BackfillProgress = {},
): Promise<number> {
  assertSameTenant(principal, config.tenantId);
  if (config.sources.includes('teams')) await syncEntraDirectory(principal, client);
  const report = await buildWorkforce(client, config, await loadEntraDirectory(principal));
  const read = async (past: number) => (await collectSignals(client, config, report, past)).signals;
  return backfillBaselines(principal, at, config.timeZone ?? 'UTC', weeks, history(read), progress);
}

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
  const report = await buildWorkforce(client, config, await loadEntraDirectory(principal));
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
  const lifecycle = await reconcileIncidents(principal, at, helix.incidents, collected.signals, unavailable);
  const incidents = lifecycle.open;

  // Anomalies AFTER the lifecycle, so the "never learn an outage" rule sees
  // this poll's open set: a subject with an open incident is judged but not
  // learned from.
  const { anomalies } = await detectAndLearn(principal, at, config.timeZone ?? 'UTC',
    metricsFromSignals(collected.signals),
    new Set(incidents.map((i) => i.subject.kind + ':' + i.subject.id)));
  await putAnomalies(principal, nowIso(), anomalies);
  const workforce = summariseWorkforce(report, nowIso());

  // Kurmi: the Cisco phones. Independent of everything above - devices, not
  // people - and isolated like every other source.
  let phones: PhoneInventory | undefined;
  let kurmiError: string | undefined;
  if (config.kurmi) {
    try {
      phones = await pullPhoneInventory(client, config, nowIso());
    } catch (err) {
      kurmiError = errorLine(err);
    }
    // OUTSIDE the try. Kurmi's catch turns any error into "Kurmi is down";
    // our own store failing to write is not Kurmi's fault, and reporting it
    // as a vendor outage would send someone to the wrong team.
    if (phones) await putPhoneInventory(principal, phones);
  }

  const health = await recordHealth(principal, at, observeRun({
    config, directorySync, directoryError, report,
    signalErrors: collected.errors, helixError: helix.error, kurmiError, phones,
  }), dataQuality(report, collected.unmappedBandwidthPeers, phones, collected.unmappedStarlinkTerminals));

  await putCommsRun(principal, { workforce, alarms });
  return {
    report, directorySync, workforce, signals: collected.signals, alarms, incidents,
    resolved: lifecycle.resolved, reopened: lifecycle.reopened, phones, anomalies, health,
  };
}
