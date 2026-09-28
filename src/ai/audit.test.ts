/**
 * The audit's outcome is decided where it is known, and its tallies say
 * which window they cover.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import type { Principal } from '../platform/types.ts';
import { setRunbooks } from '../platform/runbook-loader.ts';
import { loadRunbooksFromDisk } from '../platform/runbook-loader.node.ts';
import { prepareToolWorld, runAudited, runToolAs } from './tool-provider.ts';
import { summariseAudit, type AuditEntry } from './audit.ts';

const VIEWER: Principal = {
  sub: 'v', email: 'v@acme-networks.com', tenantId: 'acme-networks',
  roles: ['viewer'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
};

before(async () => {
  setRunbooks(loadRunbooksFromDisk());
  await prepareToolWorld(VIEWER);
});

test('refused is the ROLE CHECK saying no - not filed under error, where an admin would not look for it', async () => {
  assert.equal((await runToolAs('openIncident', { title: 'x', severity: 'critical', siteId: 'dal-01', deviceIds: [] }, VIEWER)).outcome, 'refused');
  assert.equal((await runToolAs('noSuchTool', {}, VIEWER)).outcome, 'refused');
  assert.equal((await runToolAs('traceTopology', { deviceId: 'no-such-device' }, VIEWER)).outcome, 'error', 'an ERROR: answer is an error, thrown or not');
  assert.equal((await runToolAs('listOpenIncidents', {}, VIEWER)).outcome, 'ok');
});

test('runAudited records exactly what it ran, how it went, and from where', async () => {
  const seen: Array<{ tool: string; outcome: string; via?: string }> = [];
  const run = await runAudited('openIncident', {}, VIEWER, 'tab', async (_p, c) => { seen.push({ tool: c.tool, outcome: c.outcome, via: c.via }); });
  assert.match(run.text, /^ERROR: role viewer/);
  assert.deepEqual(seen, [{ tool: 'openIncident', outcome: 'refused', via: 'tab' }]);
});

test('the summary: tallies and a window, most-called tool first, median not mean', () => {
  const e = (tool: string, outcome: AuditEntry['outcome'], ms: number, at: string): AuditEntry =>
    ({ at, sub: 's', tool, argsHash: 'h', outcome, ms, via: 'mcp' });
  const s = summariseAudit([
    e('searchRunbooks', 'ok', 10, '2026-09-28T10:00:03Z'),
    e('searchRunbooks', 'ok', 20, '2026-09-28T10:00:02Z'),
    e('searchRunbooks', 'error', 9000, '2026-09-28T10:00:01Z'),
    e('traceTopology', 'refused', 0, '2026-09-28T09:59:00Z'),
  ]);
  assert.deepEqual({ calls: s.calls, ok: s.ok, error: s.error, refused: s.refused }, { calls: 4, ok: 2, error: 1, refused: 1 });
  assert.deepEqual(s.byTool.map((t) => t.tool), ['searchRunbooks', 'traceTopology']);
  assert.equal(s.byTool[0].medianMs, 20, 'one slow call does not become the typical one');
  assert.deepEqual([s.from, s.to], ['2026-09-28T09:59:00Z', '2026-09-28T10:00:03Z']);
  assert.deepEqual(summariseAudit([]).byTool, []);
});
