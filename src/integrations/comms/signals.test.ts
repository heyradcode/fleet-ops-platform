/**
 * Comms signals, alarms and incidents, against the mocks' planted incidents.
 *
 * The mocks plant three things in the last forty minutes - a failing SBC, a
 * degraded Houston network seen by both Teams and Webex, and a swamped queue.
 * These tests pin that exactly those three become incidents, and just as
 * importantly that the corroboration rule holds the facility one back the
 * moment its second witness is taken away.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now } from '../../platform/clock.ts';
import {
  DEMO_CLIENT, DEMO_WEBEX_TOKEN, DEMO_BANDWIDTH_USER, directory, GENESYS_PLANTED_QUEUE, mockFetch, resetMockState, TEAMS_PLANTED,
} from './mock/index.ts';
import { createCommsClient } from './client.ts';
import { buildWorkforce } from './workforce.ts';
import { loadEntraDirectory, syncEntraDirectory } from './entra-directory.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { collectSignals, COMMS_THRESHOLDS, isoDurationMs, type CommsSignal } from './signals.ts';
import { correlateAlarms, evaluateSignals } from './incidents.ts';
import type { CommsSource } from './types.ts';

beforeEach(() => {
  setClock(fixedClock());
  resetMockState();
});

async function run(sources: CommsSource[] = ['teams', 'genesys', 'webex']) {
  const config = { ...structuredClone(COMMS_CONFIG[HHS_DEMO_TENANT]), sources };
  const client = createCommsClient({
    tenantId: HHS_DEMO_TENANT,
    fetch: mockFetch,
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
      genesys: { ...DEMO_CLIENT },
      webex: { token: DEMO_WEBEX_TOKEN },
      bandwidth: { ...DEMO_BANDWIDTH_USER },
    },
    sleep: async () => {},
  });
  // The workforce always needs Entra for placement, whichever signal sources run.
  const principal = {
    sub: 'test', email: 'ops-lead@hhs.texas.example', tenantId: HHS_DEMO_TENANT,
    roles: ['admin' as const], scope: { kind: 'tenant' as const }, identityProvider: 'cognito' as const,
  };
  await syncEntraDirectory(principal, client);
  const workforce = await buildWorkforce(client, { ...config, sources: ['teams', 'genesys', 'webex'] },
    loadEntraDirectory(principal));
  const signals = await collectSignals(client, config, workforce, now());
  const alarms = evaluateSignals(signals);
  return { signals, alarms, incidents: correlateAlarms(alarms) };
}

const firing = (signals: CommsSignal[]) => signals.filter((s) => s.severity === 'warning' || s.severity === 'critical');

test('isoDurationMs reads Graph durations, and refuses what it cannot read', () => {
  assert.equal(isoDurationMs('PT0.018S'), 18);
  assert.equal(isoDurationMs('PT1M2.5S'), 62_500);
  assert.equal(isoDurationMs('PT1H'), 3_600_000);
  assert.throws(() => isoDurationMs('0.018'));
  assert.throws(() => isoDurationMs('PT'));
});

test('signals: exactly the planted problems fire, and nothing else does', async () => {
  const { signals } = await run();
  const fired = firing(signals).map((s) => s.source + ' ' + s.kind + ' ' + s.subject.id).sort();
  assert.deepEqual(fired, [
    'genesys queue-abandonment ' + signals.find((s) => s.subject.name === GENESYS_PLANTED_QUEUE)!.subject.id,
    'genesys queue-backlog ' + signals.find((s) => s.subject.name === GENESYS_PLANTED_QUEUE)!.subject.id,
    'teams facility-media-degradation ' + TEAMS_PLANTED.degradedFacility,
    'teams trunk-call-failure ' + TEAMS_PLANTED.failingTrunk,
    'webex facility-media-degradation ' + TEAMS_PLANTED.degradedFacility,
    // The carrier's end of the same SBC, on the same subject - mapped by peer id.
    'bandwidth trunk-call-failure ' + TEAMS_PLANTED.failingTrunk,
  ].sort());
});

test('signals: no rate is emitted below its minimum sample', async () => {
  const { signals } = await run();
  const min: Record<string, number> = {
    'trunk-call-failure': COMMS_THRESHOLDS.trunkFailure.minSamples,
    'facility-media-degradation': COMMS_THRESHOLDS.mediaDegradation.minSamples,
    'queue-abandonment': COMMS_THRESHOLDS.queueAbandonment.minSamples,
  };
  for (const s of signals) {
    if (s.kind in min) assert.ok(s.sampleSize >= min[s.kind], s.kind + ' ' + s.subject.name + ' n=' + s.sampleSize);
  }
  // And the healthy trunk is measured, not merely absent.
  assert.ok(signals.some((s) => s.kind === 'trunk-call-failure' && s.severity === 'ok'));
});

test('incidents: three, one per planted subject, the facility one from two services', async () => {
  const { incidents } = await run();
  assert.deepEqual(incidents.map((i) => i.subject.kind + ':' + i.subject.name).sort(), [
    'facility:LC=' + TEAMS_PLANTED.degradedFacility,
    'queue:' + GENESYS_PLANTED_QUEUE,
    'trunk:' + TEAMS_PLANTED.failingTrunk,
  ].sort());

  const facility = incidents.find((i) => i.subject.kind === 'facility')!;
  assert.deepEqual(facility.sources, ['teams', 'webex']);

  // Both ends of the SBC saw it, so the incident says where: the SBC itself.
  const trunk = incidents.find((i) => i.subject.kind === 'trunk')!;
  assert.deepEqual(trunk.sources, ['bandwidth', 'teams']);
  assert.match(trunk.localisation.join(' '), /Both legs failing/);

  // Backlog and abandonment on one queue are one incident, not two pages.
  const queue = incidents.find((i) => i.subject.kind === 'queue')!;
  assert.deepEqual(queue.kinds, ['queue-abandonment', 'queue-backlog']);
});

test('corroboration: take Webex away and the facility alarm is raised but held back', async () => {
  const { alarms, incidents } = await run(['teams', 'genesys']);
  const facility = alarms.find((a) => a.subject.kind === 'facility')!;
  assert.equal(facility.corroborated, false);
  assert.match(facility.heldBack!, /single source/);
  assert.ok(!incidents.some((i) => i.subject.kind === 'facility'));

  // The self-evident kinds still page on one source.
  assert.ok(incidents.some((i) => i.subject.kind === 'trunk'));
  assert.ok(incidents.some((i) => i.subject.kind === 'queue'));
});

test('corroboration: a dissenting source holds the alarm back and is named', () => {
  const base = {
    tenantId: 't', subject: { kind: 'facility' as const, id: '1120', name: 'LC=1120' },
    kind: 'facility-media-degradation' as const, unit: 'ratio' as const, sampleSize: 50,
    window: { from: '2026-09-08T14:00:00.000Z', to: '2026-09-08T14:30:00.000Z' }, detail: '',
  };
  const alarms = evaluateSignals([
    { ...base, signalId: 'a', source: 'teams', value: 0.9, severity: 'critical' },
    { ...base, signalId: 'b', source: 'webex', value: 0.01, severity: 'ok' },
  ]);
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].corroborated, false);
  assert.deepEqual(alarms[0].dissent, ['webex']);
  assert.match(alarms[0].heldBack!, /disputed/);
  assert.deepEqual(correlateAlarms(alarms), []);
});

test('ids are content hashes: the same window evaluated twice gives the same ids', async () => {
  const a = await run();
  resetMockState();
  const b = await run();
  assert.deepEqual(a.signals.map((s) => s.signalId), b.signals.map((s) => s.signalId));
  assert.deepEqual(a.incidents.map((i) => i.incidentId), b.incidents.map((i) => i.incidentId));
});
