/**
 * Anomaly explanation. The claims pinned: unusual for THIS subject at THIS
 * hour of the week, in the customer's zone; no verdict without history; never
 * learning an outage; floors that stop noise reading as news; and anomalies as
 * early warnings and context, never alarms.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import { mainTable } from '../../aws/dynamodb.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_CUCM_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN, directory,
  GENESYS_PLANTED_QUEUE, GENESYS_SUBTLE_QUEUE, genesysQueues, mockFetch, mockHistory, resetMockState, TEAMS_PLANTED,
} from './mock/index.ts';
import { createCommsClient } from './client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { backfillCommsBaselines, runCommsPoll } from './poll.ts';
import { detectAndLearn, hourOfWeek, learnOnly, type MetricPoint } from './anomalies.ts';
import { toolByName } from '../../ai/tools.ts';
import { buildDailyBrief } from '../../reporting/daily-brief.ts';

beforeEach(() => {
  setClock(fixedClock());
  resetMockState();
});

function setup(tenantId: string) {
  COMMS_CONFIG[tenantId] = { ...structuredClone(COMMS_CONFIG[HHS_DEMO_TENANT]), tenantId };
  const config = COMMS_CONFIG[tenantId];
  const principal: Principal = {
    sub: 't', email: 'ops-lead@hhs.texas.example', tenantId,
    roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  const client = createCommsClient({
    tenantId, fetch: mockFetch,
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT }, genesys: { ...DEMO_CLIENT },
      webex: { token: DEMO_WEBEX_TOKEN }, bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER }, kurmi: { ...DEMO_KURMI_USER }, cucm: { ...DEMO_CUCM_USER }, starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
    },
    sleep: async () => {},
  });
  return {
    principal,
    backfill: () => backfillCommsBaselines(principal, client, config, now(), 8, mockHistory),
    poll: () => runCommsPoll(principal, client, config, now()),
  };
}

const baselinesOf = (tenantId: string) => mainTable.query({ pk: 'TENANT#' + tenantId + '#BASELINE' });

test('hour of the week is the CUSTOMER\'s: a winter and a summer Tuesday 9am share a bucket', () => {
  const summer = Date.parse('2026-09-08T14:30:00Z');   // 09:30 CDT (UTC-5)
  const winter = Date.parse('2026-01-06T15:30:00Z');   // 09:30 CST (UTC-6)
  assert.equal(hourOfWeek(summer, 'America/Chicago'), 2 * 24 + 9);
  assert.equal(hourOfWeek(winter, 'America/Chicago'), 2 * 24 + 9);
  assert.notEqual(hourOfWeek(summer, 'UTC'), hourOfWeek(winter, 'UTC'), 'a fixed offset would split them');
});

test('no history, no verdict', async () => {
  const { poll } = setup('a-fresh');
  const r = await poll();
  assert.deepEqual(r.anomalies, []);
});

test('with eight weeks of history: exactly the unusual things, and nothing healthy', async () => {
  const { backfill, poll } = setup('a-found');
  await backfill();
  const r = await poll();
  const key = (s: { kind: string; name: string }) => s.kind + ':' + s.name;
  const flagged = new Set(r.anomalies.map((a) => key(a.subject)));

  // The proactive find: a volume surge on a queue with NO incident and no rule.
  const subtle = r.anomalies.find((a) => a.subject.name === GENESYS_SUBTLE_QUEUE)!;
  assert.equal(subtle.metric, 'queue-abandonment:volume');
  assert.equal(subtle.direction, 'above');
  assert.ok(!r.incidents.some((i) => i.subject.name === GENESYS_SUBTLE_QUEUE), 'nothing fired on it');

  // The dead SBC's silence: fewer calls, not more failures.
  assert.ok(r.anomalies.some((a) => a.subject.id === TEAMS_PLANTED.failingTrunk &&
    a.metric === 'trunk-call-failure:volume' && a.direction === 'below'));

  // Nothing about the healthy subjects.
  const allowed = new Set([
    'queue:' + GENESYS_SUBTLE_QUEUE, 'queue:' + GENESYS_PLANTED_QUEUE,
    'trunk:' + TEAMS_PLANTED.failingTrunk, 'facility:LC=' + TEAMS_PLANTED.degradedFacility,
    'facility:LC=3308',   // Lubbock's obstructed dish
  ]);
  for (const f of flagged) assert.ok(allowed.has(f), 'unexpected anomaly on ' + f);
});

test('it never learns an outage: incident subjects and anomalous values are not folded in', async () => {
  const { backfill, poll } = setup('a-learn');
  await backfill();
  const before = new Map((await baselinesOf('a-learn')).map((b) => [b.SK, Number(b.n)]));
  await poll();
  const after = new Map((await baselinesOf('a-learn')).map((b) => [b.SK, Number(b.n)]));
  // Baseline keys carry the subject ID - for a queue a UUID, never its name.
  // Matching on the name made the first version of this test check nothing.
  const idOf = (name: string) => genesysQueues().find((q) => q.name === name)!.id;
  const planted = 'queue:' + idOf(GENESYS_PLANTED_QUEUE) + '|';
  const subtleVolume = 'queue:' + idOf(GENESYS_SUBTLE_QUEUE) + '|queue-abandonment:volume|';
  let checkedIncident = 0;
  let checkedAnomalous = 0;
  for (const [sk, n] of after) {
    const wasN = before.get(sk) ?? 0;
    if (sk.startsWith(planted) || sk.startsWith('trunk:' + TEAMS_PLANTED.failingTrunk + '|')) {
      assert.equal(n, wasN, 'open incident, not learned: ' + sk);
      checkedIncident++;
    }
    if (sk.startsWith(subtleVolume)) {
      assert.equal(n, wasN, 'anomalous value, not learned: ' + sk);
      checkedAnomalous++;
    }
  }
  assert.ok(checkedIncident > 0 && checkedAnomalous > 0, 'the assertions above must have run');
  assert.ok([...after].some(([sk, n]) => n > (before.get(sk) ?? 0)), 'healthy values ARE learned');
});

test('floors: one caller where there are usually none, and Poisson-sized volume noise, are not news', async () => {
  const p: Principal = { sub: 't', email: 'x', tenantId: 'a-floor', roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito' };
  const at = now();
  const pt = (metric: MetricPoint['metric'], value: number, unit: 'ratio' | 'count'): MetricPoint =>
    ({ subject: { kind: 'queue', id: 'q', name: 'Q' }, metric, source: 'genesys', value, unit });
  for (let w = 0; w < 8; w++) {
    await learnOnly(p, at, 'America/Chicago', [pt('queue-backlog', 0, 'count'), pt('queue-abandonment:volume', 17 + (w % 3) - 1, 'count')]);
  }
  const r = await detectAndLearn(p, at, 'America/Chicago',
    [pt('queue-backlog', 1, 'count'), pt('queue-abandonment:volume', 24, 'count')], new Set());
  assert.deepEqual(r.anomalies, [], 'zero-spread baselines would otherwise make these infinitely unusual');
});

test('the brief and the assistant: early warning apart from context', async () => {
  const { principal, backfill, poll } = setup('a-surface');
  await backfill();
  await poll();
  const b = await buildDailyBrief(principal, now(), { networkIncidents: [] });
  assert.ok(b.unusual.some((u) => u.includes(GENESYS_SUBTLE_QUEUE)));
  assert.ok(b.open.some((o) => o.normally?.startsWith('Normally ')), 'incidents gain their normal range');

  const out = await toolByName('explainAnomalies')!.execute({}, principal);
  const [early, context] = out.split('CONTEXT for open incidents:');
  assert.match(early, new RegExp(GENESYS_SUBTLE_QUEUE));
  assert.match(context, /sbc2/);
});
