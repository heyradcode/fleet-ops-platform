/**
 * The external plane: observing a device from outside it.
 *
 * The other two planes both depend on something choosing to speak. A switch
 * reports its own events upward; a cloud reports what it last heard. Neither
 * survives the failure mode that matters most - a device that is wedged,
 * powered off, or cut off behind a failed uplink says nothing at all, and its
 * cloud eventually says nothing new. Silence is not an observation, and a platform
 * that only listens cannot tell "healthy and quiet" from "gone".
 *
 * So we go and look. In production this is a prober in the VPC doing ICMP or a
 * TCP connect against each management address on a schedule; here it is the
 * same shape with the network call injected, for the same reason the clock is
 * injected - a demo that depends on real packets is not reproducible.
 *
 * WHY THIS IS A SEPARATE PLANE AND NOT JUST ANOTHER FEED. A probe result is the
 * only evidence in the system that does not originate with the thing being
 * described. That independence is the whole basis of the corroboration rule: a
 * cloud reporting a device offline, corroborated by a failed probe, is two
 * genuinely different vantage points agreeing - whereas that same cloud's status
 * endpoint agreeing with its own event log is one vendor saying it twice.
 *
 * IT MATTERS MORE NOW THAN IT DID. When devices spoke to us directly there were
 * two vendor-side planes to play off each other. Every feed is now the vendor's
 * cloud, so when that cloud is having a bad morning - stale data, a degraded
 * region, an expired token - the probe alone can tell "the estate is down" from
 * "our view of the estate is down".
 */
import type { DeviceId, Observation, Principal } from '../platform/types.ts';
import type { Inventory } from '../platform/inventory.ts';
import { observationId } from '../platform/types.ts';
import { severityForMetric } from './classify.ts';
import { nowIso } from '../platform/clock.ts';

/**
 * Does this device answer?
 *
 * Injected rather than imported so the pipeline stays pure and the demo stays
 * deterministic. The production implementation opens a socket; the scenarios
 * supply a set.
 */
export type Prober = (deviceId: DeviceId) => boolean;

/** Everything answers. The default, so an unconfigured platform is not alarmist. */
export const allReachable: Prober = () => true;

let current: Prober = allReachable;

export function setProber(p: Prober): void { current = p; }
export function resetProber(): void { current = allReachable; }

/**
 * Probe every device in the estate and emit one reachability observation each.
 *
 * Note that this emits for reachable devices too, not only failures. A platform
 * that only records bad news cannot tell "probe says up" from "probe did not
 * run", and the difference decides whether a single-plane alarm was genuinely
 * uncorroborated or merely unobserved.
 */
export function probeEstate(principal: Principal, inventory: Inventory): Observation[] {
  const receivedAt = nowIso();

  return inventory.devices().map((device) => {
    const reachable = current(device.deviceId) ? 1 : 0;

    return {
      tenantId: principal.tenantId,
      observationId: observationId(
        device.vendor, device.deviceId, 'probe', 'reachability', receivedAt,
      ),
      vendor: device.vendor,
      platform: device.platform,
      encoding: 'probe' as const,
      // The external plane, stated rather than derived. Nothing in the vendor's
      // world was involved in this observation, which is exactly what makes it
      // a second witness to anything their cloud reports.
      plane: 'external' as const,
      deviceId: device.deviceId,
      siteId: device.siteId,
      sourceRef: 'probe',
      // A probe has no device clock to disagree with: we timestamp it, and we
      // are the ones who ran it. This is the one source with no skew problem.
      observedAt: receivedAt,
      receivedAt,
      class: 'metric' as const,
      kind: 'reachability' as const,
      value: reachable,
      unit: 'boolean' as const,
      severity: severityForMetric('reachability', reachable),
      attributes: { method: 'icmp', role: device.role },
    };
  });
}
