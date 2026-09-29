/**
 * Impact: the queues a building's problem reaches - a share of ALL of each
 * queue, only the ones it staffs a fifth of, and counts, never people.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import type { Principal } from '../platform/types.ts';
import { commsIncidents } from '../integrations/comms/store.ts';
import { TEAMS_PLANTED } from '../integrations/comms/mock/index.ts';
import { HHS_ADMIN, pollHhsAndBuildGraph } from './test-world.ts';
import { writeGraph } from './store.ts';
import { describeImpact, impactForIncidents, queuesStaffedFrom } from './impact.ts';

before(async () => { await pollHhsAndBuildGraph(); });

test('Houston\'s problem reaches the Eligibility queue it staffs a fifth of - in counts', async () => {
  const impact = await queuesStaffedFrom(HHS_ADMIN, TEAMS_PLANTED.degradedFacility);
  const eligibility = impact.queues.find((q) => q.queueName === 'Eligibility - English');
  assert.ok(eligibility, JSON.stringify(impact));
  assert.ok(eligibility.agents / eligibility.members >= 0.2);
  assert.ok(impact.queues.every((q) => q.agents / q.members >= 0.2), 'only queues it staffs a fifth of are listed');
  assert.match(describeImpact(impact), /Eligibility - English \(\d+ of its \d+ agents\)/);
});

test('per incident: a building gets its queues; a trunk and a queue get nothing - they are not buildings', async () => {
  const open = await commsIncidents(HHS_ADMIN);
  const impact = await impactForIncidents(HHS_ADMIN, open);
  const houston = open.find((i) => i.subject.kind === 'facility' && i.subject.id === TEAMS_PLANTED.degradedFacility)!;
  assert.ok(impact[houston.incidentId]?.queues.some((q) => q.queueName === 'Eligibility - English'));
  for (const i of open.filter((x) => x.subject.kind !== 'facility')) assert.equal(impact[i.incidentId], undefined, i.subject.kind);
});

test('a building with a few agents in many queues lists none of them - it counts them', async () => {
  const p: Principal = { ...HHS_ADMIN, sub: 'impact-thin', tenantId: 'impact-thin' };
  const building = { type: 'Facility' as const, id: '7777' };
  const queues = Array.from({ length: 9 }, (_, i) => ({ type: 'Queue' as const, id: 'q' + i }));
  await writeGraph(p, {
    nodes: [
      { ...building, label: 'Thin Office', props: {} },
      ...queues.map((q) => ({ ...q, label: 'Queue ' + q.id, props: { members: 40, unplaced: 20 } })),
    ],
    edges: queues.map((q) => ({ from: q, rel: 'STAFFED_FROM' as const, to: building, props: { agents: 2 } })),
  });
  const impact = await queuesStaffedFrom(p, '7777');
  assert.deepEqual(impact, { queues: [], smaller: 9 });
  assert.equal(describeImpact(impact), '9 queues, none a fifth staffed from here');
  assert.ok(!JSON.stringify(impact).includes('@'), 'counts, never who');
});
