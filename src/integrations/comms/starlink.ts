/**
 * ---------------------------------------------------------------------------
 * Starlink: the satellite WAN at remote sites
 * ---------------------------------------------------------------------------
 * The telemetry stream, turned into per-facility WAN signals: latency and
 * packet drop as each dish measured its own link, with obstruction and the
 * dish's active alerts as the evidence.
 *
 * ARCHIVE FIRST, OR LOSE IT. The stream's position is advanced by the SERVER
 * when it sends a batch - CLAUDE.md's watermark rule ("advance after the
 * write") is inverted here, and not by choice. So each response body goes to
 * the raw bucket, exactly as received, BEFORE it is parsed. A crash while
 * parsing then costs a replay from S3; without the archive it would cost
 * those minutes permanently, and nothing would report the gap.
 *
 * ONE SERVICE ACCOUNT PER ENVIRONMENT. Each account has its own position; two
 * consumers on one account each get a share of the stream. That is
 * configuration, not code - see CommsCredentials.starlink - but it is the
 * mistake that makes the dev board and the prod board both quietly wrong.
 *
 * COLUMNS BY NAME, ALERTS BY ENUM. The response names its columns per device
 * type and maps alert codes in its own metadata; both are read from the
 * response every time, never assumed, so a column reordering or a new alert
 * code costs nothing.
 */
import { rawBucket } from '../../aws/s3.ts';
import { nowIso } from '../../platform/clock.ts';
import type { CommsClient } from './client.ts';
import type { CommsTenantConfig } from './types.ts';

/** Entries per stream call, and a ceiling on calls per poll (8h of three terminals is ~1,900 rows). */
export const STREAM_BATCH = 500;
export const MAX_STREAM_CALLS = 20;

export type TerminalSample = {
  deviceId: string;
  at: number;
  latencyMs: number;
  dropRate: number;
  obstruction: number;
  signalQuality: number;
  alerts: string[];
};

type StreamBody = {
  data: { columnNamesByDeviceType: Record<string, string[]>; values: unknown[][] };
  metadata: { enums: { DeviceType: Record<string, string>; AlertsByDeviceType: Record<string, Record<string, string>> } };
};

/** Pure. Columnar body -> user-terminal samples. Router rows and unknown device types are skipped. */
export function parseTelemetry(body: StreamBody): TerminalSample[] {
  const typeKey = Object.entries(body.metadata.enums.DeviceType).find(([, name]) => name === 'UserTerminal')?.[0];
  if (!typeKey) return [];
  const columns = body.data.columnNamesByDeviceType[typeKey] ?? [];
  const col = (name: string) => columns.indexOf(name);
  const alertNames = body.metadata.enums.AlertsByDeviceType[typeKey] ?? {};
  const [iTs, iId, iLat, iDrop, iObs, iSig, iAlerts] =
    ['UtcTimestampNs', 'DeviceId', 'PingLatencyMsAvg', 'PingDropRateAvg', 'ObstructionPercentTime', 'SignalQuality', 'ActiveAlerts'].map(col);
  if (iTs < 0 || iId < 0 || iLat < 0 || iDrop < 0) throw new Error('Starlink telemetry is missing a required column');

  const out: TerminalSample[] = [];
  for (const row of body.data.values) {
    if (row[0] !== typeKey) continue;
    const codes = iAlerts >= 0 && Array.isArray(row[iAlerts]) ? (row[iAlerts] as Array<number | string>) : [];
    out.push({
      deviceId: String(row[iId]),
      // Nanoseconds past 2^53: exact to the millisecond is all a number can
      // promise, and all that is used. Never an identity.
      at: Math.floor(Number(row[iTs]) / 1e6),
      latencyMs: Number(row[iLat]),
      dropRate: Number(row[iDrop]),
      obstruction: iObs >= 0 ? Number(row[iObs]) : 0,
      signalQuality: iSig >= 0 ? Number(row[iSig]) : 1,
      alerts: codes.map((c) => alertNames[String(c)] ?? 'alert ' + String(c)),
    });
  }
  return out;
}

/**
 * Drain everything new from the stream. Each body is archived, raw, BEFORE
 * it is parsed - see the header. `truncated` is the call ceiling reached with
 * data still coming: counts are then partial, and the next poll continues.
 */
export async function drainTelemetry(client: CommsClient): Promise<{ samples: TerminalSample[]; calls: number; archived: string[]; truncated: boolean }> {
  const samples: TerminalSample[] = [];
  const archived: string[] = [];
  let calls = 0;
  for (;;) {
    if (calls >= MAX_STREAM_CALLS) return { samples, calls, archived, truncated: true };
    const res = await client.request('starlink', client.endpoints.starlinkApi + '/v2/telemetry/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchSize: STREAM_BATCH, maxLingerMs: 100 }),
    });
    calls++;
    const text = await res.text();
    // BEFORE parsing. The server has already moved on.
    const key = 'raw/tenant=' + client.tenantId + '/vendor=starlink/received=' + nowIso() + '/call=' + calls + '.json';
    archived.push(rawBucket.putObject(key, text));
    const body = JSON.parse(text) as StreamBody;
    samples.push(...parseTelemetry(body));
    if (body.data.values.length < STREAM_BATCH) return { samples, calls, archived, truncated: false };
  }
}

export type SiteWan = {
  subjectId: string;
  subjectName: string;
  mapped: boolean;
  samples: number;
  latencyMs: number;
  dropRate: number;
  obstruction: number;
  alerts: string[];
};

/** Pure. Samples in the window -> one aggregate per terminal, keyed onto its facility. */
export function siteWan(
  samples: TerminalSample[], config: CommsTenantConfig, from: number, to: number,
): { sites: SiteWan[]; unmappedTerminals: string[] } {
  const table = config.starlink?.terminalFacility ?? {};
  const byTerminal = new Map<string, TerminalSample[]>();
  for (const s of samples) {
    if (s.at < from || s.at > to) continue;
    const list = byTerminal.get(s.deviceId);
    if (list) list.push(s); else byTerminal.set(s.deviceId, [s]);
  }
  const unmapped: string[] = [];
  const sites: SiteWan[] = [];
  for (const [id, list] of [...byTerminal].sort(([a], [b]) => a.localeCompare(b))) {
    const code = table[id];
    if (!code) unmapped.push(id);
    const avg = (f: (s: TerminalSample) => number) => list.reduce((a, s) => a + f(s), 0) / list.length;
    sites.push({
      subjectId: code ?? 'starlink-terminal:' + id,
      subjectName: code ? 'LC=' + code : 'Starlink terminal ' + id,
      mapped: !!code,
      samples: list.length,
      latencyMs: Math.round(avg((s) => s.latencyMs) * 10) / 10,
      dropRate: avg((s) => s.dropRate),
      obstruction: avg((s) => s.obstruction),
      alerts: [...new Set(list.flatMap((s) => s.alerts))].sort(),
    });
  }
  return { sites, unmappedTerminals: unmapped };
}
