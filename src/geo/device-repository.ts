/**
 * The estate, in memory, and the lookups the pipeline needs from it.
 *
 * In production the source of truth is Aurora PostGIS for sites and DynamoDB
 * for devices, reconciled from the controllers and from LLDP by a discovery
 * job. This module is the cache in front of both, and the pipeline reads it
 * rather than issuing a query per record - at push-feed rates that would be one
 * GetItem per syslog line, which costs more than the pipeline it feeds.
 *
 * Every function takes a `Principal` and derives its answer from that
 * principal's tenant and scope. Same discipline as platform/repository.ts: a
 * filter you have to remember is a filter you will forget.
 */
import type {
  Device, DeviceId, DeviceState, Principal, Site, SiteId,
} from '../platform/types.ts';
import { Inventory } from '../platform/inventory.ts';
import { generateEstate, US_SOUTH_REGION, type Estate } from '../data/estate.ts';
import { haversineKm, pointInPolygon } from './spatial.ts';
import { nowIso } from '../platform/clock.ts';
import { withinScope } from '../platform/tenancy.ts';

let estate: Estate | undefined;
let inventory: Inventory | undefined;
let states = new Map<DeviceId, DeviceState>();

let loadedFor: string | undefined;

/**
 * Build the estate, once per tenant.
 *
 * Called by demo.ts, the board and the test setup after seeding the clock and
 * the random source, so that the generated estate is identical on every run.
 *
 * IDEMPOTENT, AND THAT IS LOAD-BEARING. The generator draws from the seeded
 * random source, so regenerating advances it - and a second call would produce
 * a differently shuffled estate AND shift every subsequent uuid. The symptom
 * was a board that differed between two loads in the same session, which reads
 * as a caching bug and is really a determinism one. Pass `force` when you
 * genuinely want a fresh draw.
 */
export function loadEstate(tenantId?: string, force = false): Estate {
  const key = tenantId ?? '(default)';
  if (!force && estate && loadedFor === key) return estate;

  loadedFor = key;
  estate = generateEstate(tenantId);
  inventory = new Inventory(estate.sites[0].tenantId, estate.devices, estate.interfaces);
  states = new Map(estate.devices.map((d) => {
    const site = estate!.sites.find((s) => s.siteId === d.siteId)!;
    return [d.deviceId, {
      tenantId: d.tenantId,
      deviceId: d.deviceId,
      name: d.name,
      siteId: d.siteId,
      role: d.role,
      vendor: d.vendor,
      status: 'healthy' as const,
      lon: site.lon,
      lat: site.lat,
      cpuUtilisation: 0,
      interfacesDown: 0,
      uplinkDeviceId: d.uplinkDeviceId,
      updatedAt: nowIso(),
    }];
  }));
  return estate;
}

function ensure(): Estate {
  if (!estate) loadEstate();
  return estate!;
}

export function getInventory(_principal: Principal): Inventory {
  ensure();
  return inventory!;
}

export function allSites(principal: Principal): Site[] {
  return ensure().sites.filter((s) => s.tenantId === principal.tenantId);
}

export function siteById(principal: Principal, siteId: SiteId): Site | undefined {
  return allSites(principal).find((s) => s.siteId === siteId);
}

export function allDevices(principal: Principal): Device[] {
  return ensure().devices.filter((d) => d.tenantId === principal.tenantId);
}

/** Every device state this principal may see. Scope is applied here, not by callers. */
export function allDeviceStates(principal: Principal): DeviceState[] {
  ensure();
  const mine = [...states.values()].filter((s) => s.tenantId === principal.tenantId);
  return withinScope(principal, mine);
}

export function deviceState(principal: Principal, deviceId: DeviceId): DeviceState | undefined {
  return allDeviceStates(principal).find((s) => s.deviceId === deviceId);
}

/** Overwrite the cached hot state. Called by the pipeline's fold step. */
export function putDeviceStates(next: DeviceState[]): void {
  for (const s of next) states.set(s.deviceId, s);
}

/** Where a device is, for putting an alarm on a map. */
export function locationOf(
  principal: Principal, deviceId: DeviceId,
): { lon: number; lat: number; siteId: SiteId } | undefined {
  const device = allDevices(principal).find((d) => d.deviceId === deviceId);
  if (!device) return undefined;
  const site = siteById(principal, device.siteId);
  if (!site) return undefined;
  return { lon: site.lon, lat: site.lat, siteId: site.siteId };
}

/**
 * The chain of devices between this one and its site's root.
 *
 * Used by the merge rule: two alarms are the same incident when one device sits
 * under the other, which is how forty access points collapse into one page
 * about the distribution switch feeding them. Bounded rather than recursive
 * without a limit - a mis-discovered LLDP loop would otherwise hang the
 * pipeline, and a cycle in the topology graph is a real thing that happens.
 */
export function uplinkChain(principal: Principal, deviceId: DeviceId, maxHops = 8): DeviceId[] {
  const byId = new Map(allDevices(principal).map((d) => [d.deviceId, d]));
  const chain: DeviceId[] = [];
  const seen = new Set<DeviceId>([deviceId]);

  let current = byId.get(deviceId)?.uplinkDeviceId;
  while (current && chain.length < maxHops && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = byId.get(current)?.uplinkDeviceId;
  }
  return chain;
}

/** Is `a` at or above `b` in the tree - i.e. could a explain b? */
export function isUpstreamOf(principal: Principal, a: DeviceId, b: DeviceId): boolean {
  return a === b || uplinkChain(principal, b).includes(a);
}

/**
 * Devices at any site within `radiusKm` of a point.
 *
 * Note what this is really asking. Every device at a site shares that site's
 * coordinate, so this is a query about SITES that happens to return devices -
 * "which offices are inside the storm footprint", not "which switch is nearest".
 * A per-device radius search would be meaningless: forty boxes in one building
 * are all zero kilometres from each other.
 */
export function devicesWithinRadius(
  principal: Principal,
  centre: { lon: number; lat: number },
  radiusKm: number,
): DeviceState[] {
  const near = new Set(
    allSites(principal)
      .filter((s) => haversineKm(centre, { lon: s.lon, lat: s.lat }) <= radiusKm)
      .map((s) => s.siteId),
  );
  return allDeviceStates(principal).filter((d) => near.has(d.siteId));
}

/**
 * Everything that depends on this device, at any depth.
 *
 * This is the blast radius, and it is the number that decides whether an alarm
 * is worth waking someone for. An access point failing affects nobody else; the
 * distribution switch above it takes a floor with it.
 */
export function subtreeOf(principal: Principal, deviceId: DeviceId): DeviceId[] {
  const devices = allDevices(principal);
  const out: DeviceId[] = [];
  let frontier = [deviceId];
  const seen = new Set<DeviceId>([deviceId]);

  // Breadth-first with a visited set rather than recursion: a mis-discovered
  // LLDP loop is a real thing, and it would otherwise be an infinite descent.
  while (frontier.length > 0) {
    const next: DeviceId[] = [];
    for (const d of devices) {
      if (!d.uplinkDeviceId || seen.has(d.deviceId)) continue;
      if (!frontier.includes(d.uplinkDeviceId)) continue;
      seen.add(d.deviceId);
      out.push(d.deviceId);
      next.push(d.deviceId);
    }
    frontier = next;
  }
  return out;
}

/**
 * Which service region a point falls in.
 *
 * Sites are cities and never move, so this is a genuine point-in-polygon
 * question - unlike anything at device level, where forty boxes share one
 * coordinate. In production the polygons live in PostGIS and this is an
 * ST_Contains; here they are hand-drawn rings in data/estate.ts.
 */
export function regionContaining(point: { lon: number; lat: number }): string | undefined {
  return pointInPolygon(point, US_SOUTH_REGION) ? 'us-south' : undefined;
}
