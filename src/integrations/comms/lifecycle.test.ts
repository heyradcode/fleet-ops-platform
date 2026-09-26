/**
 * The comms incident lifecycle.
 *
 * The rule under test above all others: an incident resolves on a HEALTHY
 * MEASUREMENT, never on the absence of a bad one. Every "does not resolve"
 * case below is a way the absence of data could be mistaken for health.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now, type ControllableClock } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import {
  clearFaults, DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_WEBEX_TOKEN, directory,
  injectFault, mockFetch, resetMockState, setPlanted,
} from './mock/index.ts';
import { createCommsClient } from './client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { runCommsPoll } from './poll.ts';
import { reconcileIncidents, REOPEN_WITHIN_MS } from './lifecycle.ts';
import { commsResolvedIncidents } from './store.ts';
import type { CommsIncident } from './incidents.ts';

let clock: ControllableClock;
beforeEach(() => {
  clock = fixedClock();
  setClock(clock);
  resetMockState();
});

const POLL_MS = 5 * 60_000;

function setup(tenantId: string) {
  const config = { ...structuredClone(COMMS_CONFIG[HHS_DEMO_TENANT]), tenantId };
  const principal: Principal = {
    sub: 't', email: 'ops@hhs.texas.example', tenantId,
    roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  const client = createCommsClient({
    tenantId, fetch: mockFetch,
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
      genesys: { ...DEMO_CLIENT },
      webex: { token: DEMO_WEBEX_TOKEN },
      bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER },
    },
    sleep: async () => {},
  });
  /** One poll, five minutes after the last. */
  const poll = async (advance = true) => {
    if (advance) clock.advance(POLL_MS);
    return runCommsPoll(principal, client, config, now());
  };
  return { principal, poll };
}

const byKind = (incidents: CommsIncident[], kind: string) => incidents.find((i) => i.subject.kind === kind);

test('one problem is one incident across polls: same id, same opening, advancing lastSeen', async () => {
  const { poll } = setup('l-continuity');
  const first = await poll(false);
  const second = await poll();
  assert.equal(second.incidents.length, 3);
  for (const i of second.incidents) {
    const was = first.incidents.find((f) => f.subject.id === i.subject.id)!;
    assert.equal(i.incidentId, was.incidentId);
    assert.equal(i.openedAt, was.openedAt);
    assert.ok(i.lastSeenAt > was.lastSeenAt);
  }
});

test('recovery resolves after three MEASURED-healthy polls, and not before', async () => {
  const { poll, principal } = setup('l-recovery');
  await poll(false);
  setPlanted(false);
  assert.equal((await poll()).incidents.length, 3, 'one good poll is not a recovery');
  const second = await poll();
  assert.equal(second.incidents.length, 3);
  assert.ok(second.incidents.every((i) => i.clearPolls === 2));
  const third = await poll();
  assert.equal(third.incidents.length, 0);
  assert.equal(third.resolved.length, 3);
  assert.equal(commsResolvedIncidents(principal).length, 3);
});

test('a source that is DOWN cannot vouch for recovery: unknown neither counts nor resets', async () => {
  const { poll } = setup('l-unknown');
  await poll(false);
  setPlanted(false);
  await poll();                                   // queue measured clear: 1
  injectFault('genesys', 503, 10_000);
  for (let n = 0; n < 4; n++) {
    const r = await poll();
    const queue = byKind(r.incidents, 'queue')!;
    assert.ok(queue, 'still open while Genesys cannot be asked');
    assert.equal(queue.clearPolls, 1, 'neither advanced nor reset');
    assert.match(queue.lifecycleNote!, /genesys unavailable/);
  }
  clearFaults();
  await poll();                                   // 2
  const back = await poll();                      // 3 -> resolved
  assert.equal(byKind(back.incidents, 'queue'), undefined);
  assert.ok(back.resolved.some((i) => i.subject.kind === 'queue'));
});

test('still firing but held back RESETS the count - Houston bad while Webex is down is not recovery', async () => {
  const { poll } = setup('l-held');
  await poll(false);
  setPlanted(false);
  await poll();
  const two = await poll();
  assert.equal(byKind(two.incidents, 'facility')!.clearPolls, 2);

  setPlanted(true);
  injectFault('webex', 503, 10_000);
  const r = await poll();
  const houston = byKind(r.incidents, 'facility')!;
  assert.equal(houston.clearPolls, 0);
  assert.match(houston.lifecycleNote!, /still firing/);
});

test('too few samples to measure is not health: no signal, no resolution', () => {
  const principal: Principal = {
    sub: 't', email: 'x', tenantId: 'l-samples', roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  const at = now();
  const incident: CommsIncident = {
    tenantId: 'l-samples', incidentId: 'x', title: 'SBC quiet at 3am', severity: 'critical',
    subject: { kind: 'trunk', id: 'sbc9', name: 'sbc9' }, alarmIds: [], kinds: ['trunk-call-failure'],
    sources: ['teams'], localisation: [], openedAt: new Date(at).toISOString(), evidence: [],
    status: 'open', lastSeenAt: new Date(at).toISOString(), clearPolls: 0, reopenCount: 0, peakSeverity: 'critical',
  };
  reconcileIncidents(principal, at, [incident], [], []);
  for (let n = 1; n <= 5; n++) {
    // No signal at all: the trunk carried too few calls to compute a rate.
    const r = reconcileIncidents(principal, at + n * POLL_MS, [], [], []);
    assert.equal(r.open.length, 1, 'poll ' + n);
    assert.match(r.open[0].lifecycleNote!, /too few samples/);
  }
});

test('flapping reopens the SAME incident inside the window, and a new one outside it', async () => {
  const { poll } = setup('l-flap');
  const first = await poll(false);
  const trunkId = byKind(first.incidents, 'trunk')!.incidentId;
  setPlanted(false);
  await poll(); await poll(); await poll();       // resolved

  setPlanted(true);
  const back = await poll();                      // 5 minutes later: inside the window
  const reopened = byKind(back.incidents, 'trunk')!;
  assert.equal(reopened.incidentId, trunkId);
  assert.equal(reopened.reopenCount, 1);
  assert.ok(back.reopened.includes(trunkId));

  setPlanted(false);
  await poll(); await poll(); await poll();       // resolved again
  clock.advance(REOPEN_WITHIN_MS + POLL_MS);
  setPlanted(true);
  const later = await poll();
  const fresh = byKind(later.incidents, 'trunk')!;
  assert.notEqual(fresh.incidentId, trunkId, 'outside the window it is a new problem');
  assert.equal(fresh.reopenCount, 0);
});
