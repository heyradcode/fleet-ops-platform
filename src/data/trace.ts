/**
 * A recorded half-hour of the estate, for the board's replay scrubber.
 *
 * THE FLEET ANALOGUE DOES NOT TRANSFER, and it is worth saying why. A fleet
 * board replays POSITIONS: sixty trucks moving along corridors, and the
 * interesting thing on screen is motion. Nothing here moves. A switch is in the
 * same rack all year, and a replay of its coordinates would be sixty identical
 * frames.
 *
 * What changes over time in a network is STATE, and specifically the shape of a
 * failure as it propagates. So this trace records a cascade: a distribution
 * switch dies, its subtree goes dark over the following minutes, and the
 * recovery runs in reverse. Scrubbing through it shows the thing an operator
 * actually needs to internalise - that forty devices going quiet is one event
 * with a direction, not forty events.
 *
 * Entirely deterministic and free of randomness. Two runs must produce
 * identical frames, or a screenshot means nothing and a diff of the demo output
 * is noise.
 */
import type { DeviceId, DeviceStatus, TenantId } from '../platform/types.ts';
import type { Estate } from './estate.ts';
import { DEMO_EPOCH } from '../platform/clock.ts';

export type HealthFrame = {
  at: string;
  /** Only devices whose status differs from healthy. Absent means healthy. */
  status: Map<DeviceId, DeviceStatus>;
};

export type HealthTrace = {
  tenantId: TenantId;
  frames: HealthFrame[];
  /** The device the cascade starts at - what the board labels as root cause. */
  rootCauseDeviceId: DeviceId;
};

/** Thirty simulated seconds per frame; sixty frames is half an hour. */
export const FRAME_INTERVAL_MS = 30_000;

/**
 * Build the trace.
 *
 * The timings are chosen to match how a real cascade actually unfolds, because
 * a replay that collapses instantly teaches the wrong intuition:
 *
 *   frame 10   the distribution switch fails
 *   11-14      its directly attached devices time out, one frame apart
 *   15-18      anything below those follows
 *   34         the switch comes back
 *   35-40      the subtree recovers, in the same order
 *
 * That spread is also why the merge window is ten minutes rather than one: at
 * this cadence the last device to notice is four minutes behind the first, and
 * a tighter window would split one outage across several incidents.
 */
export function generateHealthTrace(estate: Estate, frameCount = 60): HealthTrace {
  const tenantId = estate.sites[0].tenantId;

  // The distribution switch with the most beneath it - the failure worth
  // watching. Chosen by inspection of the topology rather than hard-coded, so
  // the trace survives a change to the generator.
  const byUplink = new Map<DeviceId, DeviceId[]>();
  for (const d of estate.devices) {
    if (!d.uplinkDeviceId) continue;
    const list = byUplink.get(d.uplinkDeviceId) ?? [];
    list.push(d.deviceId);
    byUplink.set(d.uplinkDeviceId, list);
  }

  const root = estate.devices
    .filter((d) => d.role === 'distribution')
    .sort((a, b) =>
      (byUplink.get(b.deviceId)?.length ?? 0) - (byUplink.get(a.deviceId)?.length ?? 0)
      || a.deviceId.localeCompare(b.deviceId))[0];

  if (!root) throw new Error('the estate has no distribution switch to fail');

  // Breadth-first, so devices go dark in the order the failure would reach
  // them. Sorted at each level to keep the order stable across runs.
  const waves: DeviceId[][] = [];
  let frontier = [root.deviceId];
  const seen = new Set<DeviceId>(frontier);

  while (frontier.length > 0 && waves.length < 6) {
    const next: DeviceId[] = [];
    for (const id of frontier) {
      for (const child of (byUplink.get(id) ?? []).sort()) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    if (next.length > 0) waves.push(next);
    frontier = next;
  }

  const FAIL_AT = 10;
  const RECOVER_AT = 34;

  const frames: HealthFrame[] = [];
  for (let i = 0; i < frameCount; i++) {
    const status = new Map<DeviceId, DeviceStatus>();

    if (i >= FAIL_AT && i < RECOVER_AT) {
      status.set(root.deviceId, 'down');
      // Each wave notices one frame after the one above it.
      waves.forEach((wave, depth) => {
        if (i >= FAIL_AT + depth + 1) {
          for (const id of wave) status.set(id, 'down');
        }
      });
    } else if (i >= RECOVER_AT) {
      // Recovery is not instantaneous either: the switch comes back first and
      // the subtree re-associates over the following frames.
      waves.forEach((wave, depth) => {
        if (i < RECOVER_AT + depth + 2) {
          for (const id of wave) status.set(id, 'degraded');
        }
      });
    }

    frames.push({
      at: new Date(DEMO_EPOCH + i * FRAME_INTERVAL_MS).toISOString(),
      status,
    });
  }

  return { tenantId, frames, rootCauseDeviceId: root.deviceId };
}
