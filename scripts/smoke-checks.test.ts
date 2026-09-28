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
  judgeAgent, judgeAudit, judgeBoard, judgeComms, judgeDirectRefused, judgeGatewayCall, judgeGatewayList,
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
});

test('audit: 404 is an undeployed route, null is "not an admin", rows are counted by who recorded them', () => {
  assert.equal(judgeAudit(404, undefined).status, 'fail');
  assert.equal(judgeAudit(200, null).status, 'skip');
  assert.match(judgeAudit(200, { entries: [{ via: 'mcp' }, { via: 'mcp' }, { via: 'tab' }] }).detail, /3 recent calls, 2 recorded by the MCP server/);
});

test('the Gateway, and the lock: a direct call that SUCCEEDS is the failure', () => {
  const listed = judgeGatewayList({ tools: ['searchRunbooks', 'whatServes', 'explainIncident', 'graphNeighbours'], sessionId: 's' });
  assert.equal(listed.status, 'pass');
  assert.match(listed.detail, /\(3\/3 graph tools\); Mcp-Session-Id came back/);
  assert.match(judgeGatewayList({ tools: [] }).detail, /did NOT come back/, 'a dropped session header is reported, not failed');
  assert.equal(judgeGatewayList({ error: 'HTTP 401: MCP server answered 401' }).status, 'fail');
  assert.equal(judgeGatewayCall({ text: 'INCIDENT x\n  CANDIDATE (not evidence) wan-hou01-02 ...' }).status, 'pass');
  assert.equal(judgeDirectRefused({ ok: true }).status, 'fail');
  assert.equal(judgeDirectRefused({ ok: false, error: 'HTTP 403: MCP server answered 403' }).status, 'pass');
  assert.equal(judgeDirectRefused({ ok: false, error: 'ECONNRESET' }).status, 'fail', 'a network error is not a refusal');
});

test('the agent: only "tools over MCP via Gateway" passes', () => {
  const served = (tools: string, toolsRoute?: string) =>
    ({ stoppedBecause: 'end_turn', servedBy: { host: 'agentcore', model: 'offline', turn: 1, tools, ...(toolsRoute ? { toolsRoute } : {}) } });
  assert.equal(judgeAgent(200, served('mcp', 'gateway')).status, 'pass');
  assert.match(judgeAgent(200, served('mcp', 'direct')).detail, /not pointed at the gateway/);
  assert.match(judgeAgent(200, served('in-process')).detail, /not using the MCP server/);
  assert.equal(judgeAgent(403, undefined).status, 'fail');
});
