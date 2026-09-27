/**
 * ---------------------------------------------------------------------------
 * Starlink Enterprise API - the mock
 * ---------------------------------------------------------------------------
 *   www.starlink.com   POST /api/auth/connect/token          client credentials
 *   starlink.com       POST /api/public/v2/telemetry/stream  { batchSize, maxLingerMs }
 *
 * Grounded in the published client (@gibme/starlink, MIT): its base URL,
 * token endpoint, telemetry call and the UserTerminal field names below.
 * The ALERT NAMES are placeholders - real ones arrive in each response's
 * `metadata.enums.AlertsByDeviceType`, which is exactly why the connector
 * reads them from there rather than hard-coding any.
 *
 * THE STREAM, faithfully, because its semantics are the whole point:
 *
 *   The server tracks each SERVICE ACCOUNT's position and ADVANCES IT WHEN IT
 *   SENDS a batch. A consumer that crashes mid-batch never sees those entries
 *   again. There is no watermark of ours to hold back - the only defence is
 *   archiving the raw response before touching it.
 *
 *   Positions are PER SERVICE ACCOUNT. Two consumers sharing one - dev and
 *   prod, say - each receive only part of the stream, and neither knows.
 *
 *   Retention is EIGHT HOURS. A consumer offline longer than that loses the
 *   gap, and the API does not say so.
 *
 *   Data is COLUMNAR: column names per device type, value arrays whose first
 *   element is the device-type key, alerts as numeric codes. Router rows are
 *   mixed in and must be filtered.
 *
 *   `UtcTimestampNs` is nanoseconds - past 2^53, so a JavaScript number
 *   cannot hold it exactly. Fine for millisecond maths; wrong as an identity.
 *
 * WHAT IS PLANTED: for the last forty minutes the Lubbock terminal is
 * obstructed - heavy packet drop, high latency, the obstructed alert. El Paso
 * is healthy. A third terminal (a mobile command van) maps to no facility.
 */
import { createApp, issueToken, type MockApp, type MockRequest, type MockResponse } from './kernel.ts';
import { streamFor } from './directory.ts';
import { activityAnchor, PLANTED_WINDOW_MS, plantedActive } from './time.ts';
import { now } from '../../../platform/clock.ts';

export const STARLINK_TERMINALS = {
  elPaso: 'ut01000000-00000000-00a1b2c3',
  lubbock: 'ut01000000-00000000-00d4e5f6',
  van: 'ut01000000-00000000-00ffee11',
} as const;
const ROUTER_ID = 'Router-010000000000000000A1B2C3';

/** Two service accounts, so the per-account stream position can be shown. Fake by announcement. */
export const DEMO_STARLINK_ACCOUNTS = {
  prod: { clientId: 'demo-sa-prod', clientSecret: 'demo-only-not-a-real-secret' },
  dev: { clientId: 'demo-sa-dev', clientSecret: 'demo-only-not-a-real-secret' },
} as const;

export const STARLINK_RETENTION_MS = 8 * 60 * 60 * 1000;
const MINUTE = 60_000;

/** Placeholder alert vocabulary - see the header. */
const ALERTS: Record<string, string> = { '1': 'obstructed', '2': 'thermal_throttle', '3': 'slow_ethernet_speeds' };
const UT_COLUMNS = [
  'DeviceType', 'UtcTimestampNs', 'DeviceId', 'PingLatencyMsAvg', 'PingDropRateAvg', 'ObstructionPercentTime',
  'SignalQuality', 'DownlinkThroughput', 'UplinkThroughput', 'Uptime', 'ActiveAlerts',
];
const ROUTER_COLUMNS = ['DeviceType', 'UtcTimestampNs', 'DeviceId', 'Clients', 'InternetPingLatencyMs', 'InternetPingDropRate'];

const tokenAccount = new Map<string, string>();
const positions = new Map<string, number>();

export function resetStarlink(): void {
  tokenAccount.clear();
  positions.clear();
}

type Row = { at: number; values: Array<string | number | number[]> };

/** One minute of one terminal, deterministic for that minute whatever the anchor. */
function terminalRow(id: string, at: number): Row {
  const rng = streamFor('starlink|' + id, Math.floor(at / MINUTE));
  const planted = plantedActive() && id === STARLINK_TERMINALS.lubbock && at >= activityAnchor() - PLANTED_WINDOW_MS;
  const latency = planted ? 80 + rng() * 40 : 28 + rng() * 25;
  const drop = planted ? 0.1 + rng() * 0.08 : rng() * 0.008;
  const obstruction = planted ? 0.06 + rng() * 0.05 : rng() * 0.004;
  return {
    at,
    values: ['u', at * 1e6, id, Math.round(latency * 10) / 10, Math.round(drop * 1000) / 1000,
      Math.round(obstruction * 1000) / 1000, planted ? 0.62 : 0.97,
      Math.round((planted ? 20 : 180 + rng() * 60) * 1e6), Math.round((planted ? 2 : 18 + rng() * 8) * 1e6),
      86_400 * 12, planted ? [1] : []],
  };
}

function routerRow(at: number): Row {
  return { at, values: ['r', at * 1e6, ROUTER_ID, 7, 31, 0.001] };
}

/** Every row after `after` up to now, oldest first - bounded by retention. */
function rowsAfter(after: number): Row[] {
  const end = Math.floor(now() / MINUTE) * MINUTE;
  const start = Math.max(after + MINUTE, end - STARLINK_RETENTION_MS);
  const rows: Row[] = [];
  for (let t = Math.ceil(start / MINUTE) * MINUTE; t <= end; t += MINUTE) {
    for (const id of Object.values(STARLINK_TERMINALS)) rows.push(terminalRow(id, t));
    rows.push(routerRow(t));
  }
  return rows;
}

function stream(req: MockRequest): MockResponse {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  const account = tokenAccount.get(token);
  if (!account) return { status: 401, body: { errors: [{ errorMessage: 'unknown token' }] } };
  let body: { batchSize?: number };
  try { body = JSON.parse(req.body || '{}'); } catch { return { status: 400, body: { errors: [{ errorMessage: 'body is not JSON' }] } }; }
  const batchSize = Math.min(Math.max(1, Number(body.batchSize ?? 100)), 65_000);

  // A new consumer starts at the oldest retained data.
  const after = positions.get(account) ?? now() - STARLINK_RETENTION_MS - MINUTE;
  const batch = rowsAfter(after).slice(0, batchSize);
  // ADVANCED ON SEND. Whatever happens to this response next is not our problem - see the header.
  if (batch.length > 0) positions.set(account, batch[batch.length - 1].at);

  return {
    status: 200,
    body: {
      data: {
        columnNamesByDeviceType: { u: UT_COLUMNS, r: ROUTER_COLUMNS },
        values: batch.map((r) => r.values),
      },
      metadata: { enums: { DeviceType: { u: 'UserTerminal', r: 'Router' }, AlertsByDeviceType: { u: ALERTS, r: {} } } },
    },
  };
}

export const starlinkAuth: MockApp = createApp('starlink', 'auth', [
  {
    method: 'POST',
    pattern: '/api/auth/connect/token',
    public: true,
    handler(req) {
      const form = new URLSearchParams(req.body);
      const account = Object.values(DEMO_STARLINK_ACCOUNTS).find(
        (a) => a.clientId === form.get('client_id') && a.clientSecret === form.get('client_secret'));
      if (!account || form.get('grant_type') !== 'client_credentials') {
        return { status: 400, body: { error: 'invalid_client' } };
      }
      const token = issueToken('starlink', 3600);
      tokenAccount.set(token, account.clientId);
      return { status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: 3600 } };
    },
  },
], (status, _code, message) => ({ status, body: { error: message } }));

export const starlinkApi: MockApp = createApp('starlink', 'api', [
  { method: 'POST', pattern: '/api/public/v2/telemetry/stream', handler: stream },
], (status, _code, message) => ({ status, body: { errors: [{ errorMessage: message }] } }));
