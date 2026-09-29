/**
 * Starlink: a telemetry STREAM, not a poll - and the tests pin the parts of
 * that which lose data silently when got wrong.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now, type ControllableClock } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import { rawBucket } from '../../aws/s3.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_CUCM_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN,
  directory, mockFetch, resetMockState, setPlanted, STARLINK_TERMINALS,
} from './mock/index.ts';
import { createCommsClient, type CommsCredentials } from './client.ts';
import { drainTelemetry, parseTelemetry } from './starlink.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { runCommsPoll } from './poll.ts';

let clock: ControllableClock;
beforeEach(() => {
  clock = fixedClock();
  setClock(clock);
  resetMockState();
});

const client = (starlink: CommsCredentials['starlink'], tenantId = HHS_DEMO_TENANT) => createCommsClient({
  tenantId, fetch: mockFetch,
  credentials: {
    entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT }, genesys: { ...DEMO_CLIENT },
    webex: { token: DEMO_WEBEX_TOKEN }, bandwidth: { ...DEMO_BANDWIDTH_USER },
    helix: { ...DEMO_HELIX_USER }, kurmi: { ...DEMO_KURMI_USER }, cucm: { ...DEMO_CUCM_USER }, starlink,
  },
  sleep: async () => {},
});

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

test('the stream advances on SEND: a second read returns only what is new', async () => {
  const c = client({ ...DEMO_STARLINK_ACCOUNTS.prod });
  const first = await drainTelemetry(c);
  assert.ok(first.samples.length > 0);
  const again = await drainTelemetry(c);
  assert.equal(again.samples.length, 0, 'nothing new in the same minute - the position moved when it was sent');
  clock.advance(5 * 60_000);
  const later = await drainTelemetry(c);
  assert.equal(later.samples.length, 5 * Object.keys(STARLINK_TERMINALS).length, 'five minutes of three dishes');
});

test('positions are PER SERVICE ACCOUNT: two consumers sharing one each get only part of the data', async () => {
  // Separate accounts: each sees everything.
  const prod = await drainTelemetry(client({ ...DEMO_STARLINK_ACCOUNTS.prod }));
  const dev = await drainTelemetry(client({ ...DEMO_STARLINK_ACCOUNTS.dev }));
  assert.equal(prod.samples.length, dev.samples.length);

  // Shared account: "dev" and "prod" both on prod's credentials. The second
  // consumer finds the stream already consumed - and nothing says so.
  resetMockState();
  const a = await drainTelemetry(client({ ...DEMO_STARLINK_ACCOUNTS.prod }));
  const b = await drainTelemetry(client({ ...DEMO_STARLINK_ACCOUNTS.prod }, 'other-environment'));
  assert.ok(a.samples.length > 0);
  assert.equal(b.samples.length, 0, 'the second consumer silently got nothing');
});

test('archive first: every response is in S3 before parsing - and once read, it is the ONLY copy', async () => {
  const c = client({ ...DEMO_STARLINK_ACCOUNTS.prod });
  const r = await drainTelemetry(c);
  assert.equal(r.archived.length, r.calls);
  const replayed = r.archived.flatMap((uri) => {
    const key = uri.replace(/^s3:\/\/[^/]+\//, '');
    return parseTelemetry(JSON.parse(String(rawBucket.getObject(key))));
  });
  assert.equal(replayed.length, r.samples.length, 'the archive replays to exactly what was read');
  assert.equal((await drainTelemetry(c)).samples.length, 0, 'the server will not send it again');
});

// ---------------------------------------------------------------------------
// The columnar format
// ---------------------------------------------------------------------------

const body = (columns: string[], rows: unknown[][]) => ({
  data: { columnNamesByDeviceType: { u: columns, r: ['DeviceType', 'UtcTimestampNs', 'DeviceId'] }, values: rows },
  metadata: { enums: { DeviceType: { u: 'UserTerminal', r: 'Router' }, AlertsByDeviceType: { u: { '1': 'obstructed' }, r: {} } } },
});

test('columns by NAME, routers skipped, alerts through the response\'s own enums', () => {
  // Deliberately NOT the mock's column order.
  const cols = ['DeviceType', 'ActiveAlerts', 'PingDropRateAvg', 'DeviceId', 'PingLatencyMsAvg', 'UtcTimestampNs'];
  const samples = parseTelemetry(body(cols, [
    ['u', [1, 9], 0.12, 'ut-1', 95, 1_788_877_800_000 * 1e6],
    ['r', 1_788_877_800_000 * 1e6, 'Router-1'],
  ]));
  assert.equal(samples.length, 1, 'the router row is not a terminal');
  assert.equal(samples[0].latencyMs, 95);
  assert.equal(samples[0].dropRate, 0.12);
  assert.equal(samples[0].at, 1_788_877_800_000, 'nanoseconds to milliseconds');
  assert.deepEqual(samples[0].alerts, ['obstructed', 'alert 9'], 'an unknown code is kept and named, not dropped');
});

test('a missing required column is loud, not a stream of zeros', () => {
  assert.throws(() => parseTelemetry(body(['DeviceType', 'DeviceId', 'UtcTimestampNs'], [])), /missing a required column/);
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test('Lubbock\'s obstructed dish is an incident; El Paso is measured healthy; the van is a data-quality item', async () => {
  const tenantId = 's-e2e';
  COMMS_CONFIG[tenantId] = { ...structuredClone(COMMS_CONFIG[HHS_DEMO_TENANT]), tenantId };
  const principal: Principal = {
    sub: 't', email: 'ops@hhs.texas.example', tenantId, roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  const c = client({ ...DEMO_STARLINK_ACCOUNTS.prod }, tenantId);
  const r = await runCommsPoll(principal, c, COMMS_CONFIG[tenantId], now());

  const lubbock = r.incidents.find((i) => i.subject.id === '3308')!;
  assert.equal(lubbock.title, 'Satellite WAN degraded at LC=3308');
  assert.deepEqual(lubbock.sources, ['starlink']);
  assert.ok(r.signals.some((s) => s.subject.id === '2031' && s.source === 'starlink' && s.severity === 'ok'));
  assert.ok(r.health.dataQuality.some((q) => q.kind === 'unmapped-starlink-terminal' && q.detail.includes(STARLINK_TERMINALS.van)));
  assert.equal(r.health.sources.find((s) => s.source === 'starlink')!.status, 'healthy');

  // Clear the obstruction: three measured-healthy polls resolve it.
  setPlanted(false);
  for (let n = 0; n < 3; n++) { clock.advance(5 * 60_000); await runCommsPoll(principal, c, COMMS_CONFIG[tenantId], now()); }
  const after = await runCommsPoll(principal, c, COMMS_CONFIG[tenantId], now());
  assert.ok(!after.incidents.some((i) => i.subject.id === '3308'));
});
