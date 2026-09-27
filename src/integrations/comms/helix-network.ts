/**
 * ---------------------------------------------------------------------------
 * Helix changes around a NETWORK device: the device, and everything above it
 * ---------------------------------------------------------------------------
 * The question an engineer asks the moment a switch dies: "did anyone change
 * anything - on it, or on anything it hangs off?" Answering it takes the two
 * halves of the deck's Incident Agent together: the topology (from the
 * SolarWinds / controller estate) and Helix's change records.
 *
 * THE CHAIN, NOT JUST THE DEVICE. A distribution switch that died twenty
 * minutes after a routing change on its core is a question about the core. So
 * the device's own changes come first, then each hop up its uplink chain,
 * labelled with the distance - and never SIDEWAYS: a change on a sibling
 * shares a parent, not a cause, and listing it would send someone to roll back
 * the wrong box.
 *
 * CI NAMES GO THROUGH THE ALIAS JOIN, via `peekDevice`. A CMDB's CI names are
 * usually hostnames - the same join problem the inventory already solves for
 * vendor handles - but the CMDB also holds every printer, server and UPS in
 * the organisation. `peekDevice` answers without recording a miss, so asking
 * Helix a question never inflates the inventory-drift number.
 *
 * CANDIDATES, NOT CAUSES - the same labelling as the comms context. And
 * "Helix is not configured" and "Helix did not answer" are reported as such,
 * never as "no changes".
 */
import type { DeviceId, Principal } from '../../platform/types.ts';
import { getInventory, uplinkChain } from '../../geo/device-repository.ts';
import { redactPii } from '../../ai/guardrails.ts';
import { commsConfigFor } from './config.ts';
import { CHANGE_LOOKBACK_MS } from './helix-context.ts';
import { helixClientFor, pullRecentChanges } from './helix.ts';
import { errorLine } from './types.ts';

export type DeviceChange = {
  id: string;
  summary: string;
  ci: string;
  deviceId: DeviceId;
  /** 0 = the device itself, 1 = its uplink, and so on up the chain. */
  hops: number;
  status: string;
  group: string | null;
  /** Minutes before `at` that the change ended. Null: still in progress. */
  endedMinutesBefore: number | null;
};

export type DeviceChanges =
  | { status: 'ok'; chain: DeviceId[]; changes: DeviceChange[] }
  | { status: 'not-configured' | 'unavailable'; note: string; chain: DeviceId[]; changes: [] };

const FETCH_SINCE_MS = 24 * 60 * 60 * 1000;

export async function changesAroundDevice(principal: Principal, deviceId: DeviceId, at: number): Promise<DeviceChanges> {
  const chain = [deviceId, ...uplinkChain(principal, deviceId)];
  const client = helixClientFor(principal.tenantId);
  if (!client || !commsConfigFor(principal.tenantId)?.helix) {
    return {
      status: 'not-configured', chain, changes: [],
      note: 'Helix is not configured for this tenant - change history is UNKNOWN, not empty.',
    };
  }

  let changes;
  try {
    changes = await pullRecentChanges(client, at - FETCH_SINCE_MS);
  } catch (err) {
    return {
      status: 'unavailable', chain, changes: [],
      note: 'Helix did not answer (' + errorLine(err).slice(0, 80) + ') - change history is UNKNOWN, not empty.',
    };
  }

  const inventory = getInventory(principal);
  const out: DeviceChange[] = [];
  for (const c of changes) {
    if (!c.ci) continue;
    const onDevice = inventory.peekDevice(c.ci);
    const hops = onDevice ? chain.indexOf(onDevice) : -1;
    if (hops < 0) continue;                                   // not on this chain - sideways or unrelated
    if (c.actualStart === undefined || c.actualStart > at) continue;
    if (c.actualEnd !== undefined && c.actualEnd < at - CHANGE_LOOKBACK_MS) continue;
    out.push({
      id: c.id,
      summary: redactPii(c.summary),
      ci: c.ci,
      deviceId: chain[hops],
      hops,
      status: c.status,
      group: c.group,
      endedMinutesBefore: c.actualEnd === undefined ? null : Math.round((at - c.actualEnd) / 60_000),
    });
  }
  // The device first, then up the chain; within a hop, the most recent first.
  out.sort((a, b) => a.hops - b.hops || (a.endedMinutesBefore ?? 0) - (b.endedMinutesBefore ?? 0));
  return { status: 'ok', chain, changes: out };
}

export function describeDeviceChange(c: DeviceChange): string {
  const where = c.hops === 0 ? 'ON THIS DEVICE' : 'upstream, ' + c.hops + ' hop' + (c.hops === 1 ? '' : 's') + ' (' + c.deviceId + ')';
  const when = c.endedMinutesBefore === null ? 'still in progress' : 'ended ' + c.endedMinutesBefore + ' min ago';
  return c.id + ' "' + c.summary + '" - ' + where + ', ' + when + ', ' + (c.group ?? 'unassigned') +
    ' - a CANDIDATE, not an established cause';
}
