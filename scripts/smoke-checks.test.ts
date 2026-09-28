/**
 * The smoke test's judgement, against the REAL shapes: the snapshots the
 * board API serves, round-tripped through JSON as they are on the wire.
 * The script cannot be run here against AWS - it needs a person's token - so
 * what it concludes is what gets tested.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { signDemoToken } from '../src/auth/cognito-jwt-verifier.ts';
import { setClock, fixedClock, now } from '../src/platform/clock.ts';
import { boardSnapshot, commsSnapshot, type CommsSnapshot } from '../src/api/board-api.ts';
import { HHS_ADMIN, pollHhsAndBuildGraph } from '../src/graph/test-world.ts';
import {
  judgeAgent, judgeAudit, judgeBoard, judgeComms, judgeGatewayCall, judgeGatewayList,
  parseEnvFile, tokenSummary,
} from './smoke-checks.ts';

const wire = <T>(x: T): unknown => JSON.parse(JSON.stringify(x));
let comms: CommsSnapshot;

before(async () => {
  await pollHhsAndBuildGraph();
  comms = (await commsSnapshot(HHS_ADMIN))!;
});

test('the token summary says who you are - and never contains the token', () => {
  setClock(fixedClock());
  const token = signDemoToken({ sub: 'u-123', 'custom:tenantId': 'hhs-demo', 'cognito:groups': ['admin'] });
  const s = tokenSummary(token, now());
  assert.deepEqual({ tenant: s.tenant, groups: s.groups, tokenUse: s.tokenUse }, { tenant: 'hhs-demo', groups: ['admin'], tokenUse: 'access' });
  assert.equal(s.minutesLeft, 60);
  const printed = JSON.stringify(s);
  for (const part of token.split('.')) assert.ok(!printed.includes(part), 'no segment of the token in the report');
  assert.throws(() => tokenSummary('not-a-jwt', now()), /not a JWT/);
  // A line break still DECODES - and would make fetch throw an error quoting
  // the whole token. Refused before any request, without quoting it.
  const wrapped = token.slice(0, 20) + '\n' + token.slice(20);
  assert.throws(() => tokenSummary(wrapped, now()), (e: unknown) =>
    e instanceof Error && /not a JWT/.test(e.message) && !token.split('.').some((p) => e.message.includes(p)));
});

test('the env file, as pnpm web:env writes it', () => {
  assert.deepEqual(parseEnvFile('# comment\r\nVITE_BOARD_API_URL=https://x.example\r\n\r\nVITE_AGENT_RUNTIME_ARN="arn:aws:x"\n'),
    { VITE_BOARD_API_URL: 'https://x.example', VITE_AGENT_RUNTIME_ARN: 'arn:aws:x' });
});

test('board: the HHS estate passes; Acme\'s sites under an HHS token mean an old Lambda; 401 means a stale token', () => {
  assert.equal(judgeBoard(200, wire(boardSnapshot(HHS_ADMIN)), 'hhs-demo').status, 'pass');
  const old = judgeBoard(200, { sites: [{ siteId: 'dal-01' }, { siteId: 'den-01' }] }, 'hhs-demo');
  assert.equal(old.status, 'fail');
  assert.match(old.fix ?? '', /build:lambda/);
  assert.match(judgeBoard(401, undefined, 'hhs-demo').fix ?? '', /sign in/);
});

test('comms: Houston\'s candidate passes; no causes field, or an unbuilt graph, each name their fix', () => {
  const ok = judgeComms(200, wire(comms));
  assert.equal(ok.status, 'pass');
  assert.match(ok.detail, /top candidate wan-hou01-02/);
  const { causes: _drop, ...older } = comms;
  assert.match(judgeComms(200, wire(older)).fix ?? '', /build:lambda/, 'a Lambda from before phase 3');
  const unbuilt = { ...comms, causes: Object.fromEntries(Object.keys(comms.causes).map((id) => [id, { status: 'unknown', reason: 'no graph' }])) };
  assert.match(judgeComms(200, wire(unbuilt)).fix ?? '', /seed:aws/, 'the graph is not in DynamoDB');
  assert.equal(judgeComms(200, null).status, 'skip');
  assert.match(judgeComms(401, undefined).fix ?? '', /sign in/, 'a 401 is the token, not the deploy');
});

test('audit: 404 is an undeployed route, null is "not an admin", rows are counted by who recorded them', () => {
  assert.equal(judgeAudit(404, undefined).status, 'fail');
  assert.equal(judgeAudit(200, null).status, 'skip');
  const rows = [{ via: 'mcp', sub: 'me', at: '2026-09-28T10:05:00Z' }, { via: 'mcp', sub: 'someone', at: '2026-09-28T10:06:00Z' },
    { via: 'tab', sub: 'me', at: '2026-09-28T10:07:00Z' }];
  assert.match(judgeAudit(200, { entries: rows }).detail, /3 recent calls, 2 recorded by the MCP server/);
});

test('audit: after this run called a tool, a trail with no row for it FAILS - audit writes fail silently by design', () => {
  const rows = [{ via: 'mcp', sub: 'me', at: '2026-09-28T10:05:00Z' }];
  assert.equal(judgeAudit(200, { entries: rows }, { sub: 'me', since: '2026-09-28T10:00:00Z' }).status, 'pass');
  const missing = judgeAudit(200, { entries: rows }, { sub: 'me', since: '2026-09-28T11:00:00Z' });
  assert.equal(missing.status, 'fail', 'an older row of mine is not this run');
  assert.match(missing.fix ?? '', /LeadingKeys/);
  assert.equal(judgeAudit(200, { entries: rows }, { sub: 'someone-else', since: '2026-09-28T10:00:00Z' }).status, 'fail', 'nor is someone else\'s');
});

test('the Gateway: tools listed, graph tools there, and whether the session header came back', () => {
  const listed = judgeGatewayList({ tools: ['searchRunbooks', 'whatServes', 'explainIncident', 'graphNeighbours'], sessionId: 's' });
  assert.equal(listed.status, 'pass');
  assert.match(listed.detail, /\(3\/3 graph tools\); Mcp-Session-Id came back/);
  assert.match(judgeGatewayList({ tools: ['searchRunbooks'] }).detail, /did NOT come back/, 'a dropped session header is reported, not failed');
  assert.equal(judgeGatewayList({ tools: [] }).status, 'fail', 'a server that lists nothing is not working');
  assert.equal(judgeGatewayList({ tools: ['searchRunbooks'] }, true).status, 'fail', 'an HHS admin must see the graph tools');
  assert.equal(judgeGatewayList({ error: 'HTTP 401: MCP server answered 401' }).status, 'fail');
  assert.equal(judgeGatewayCall({ tool: 'explainIncident', text: 'INCIDENT x\n  CANDIDATE (not evidence) wan-hou01-02 ...' }).status, 'pass');
});

test('the agent: only "tools over MCP via Gateway" passes', () => {
  const served = (tools: string, toolsRoute?: string) =>
    ({ stoppedBecause: 'end_turn', servedBy: { host: 'agentcore', model: 'offline', turn: 1, tools, ...(toolsRoute ? { toolsRoute } : {}) } });
  assert.equal(judgeAgent(200, served('mcp', 'gateway')).status, 'pass');
  assert.match(judgeAgent(200, served('mcp', 'direct')).detail, /not pointed at the gateway/);
  assert.match(judgeAgent(200, served('in-process')).detail, /not using the MCP server/);
  assert.equal(judgeAgent(403, undefined).status, 'fail');
  assert.match(judgeAgent(0, undefined, 'The operation was aborted due to timeout').detail, /no answer: .*timeout/, 'a timeout says so');
  assert.match(judgeAgent(401, undefined).fix ?? '', /sign in/);
});
