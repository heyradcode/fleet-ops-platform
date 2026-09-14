/**
 * ---------------------------------------------------------------------------
 * Inventory: turning what the wire says into who it actually is
 * ---------------------------------------------------------------------------
 * A fleet platform gets its join key for free - the telematics vendor hands you
 * a driver id and every reading is addressable from the moment it is decoded.
 * Nothing hands us that here, and this file is the difference.
 *
 * THE SAME SWITCH ARRIVES UNDER FIVE NAMES:
 *
 *   syslog       a hostname the device was configured with, years ago
 *   SNMP         sysName, which is a DIFFERENT editable string
 *   any feed     a source IP, which changes on a DHCP renewal
 *   controller   a chassis serial or a cloud-assigned device id
 *   LLDP         a chassis-id, usually a MAC, occasionally the hostname
 *
 * Four of those five are operator-editable and one moves on its own. So the
 * platform assigns its OWN `deviceId` and treats every vendor string as an
 * alias pointing at it. Nothing downstream is allowed to key on a wire string;
 * mappers that cannot resolve a host drop the record rather than invent an
 * identity, because a metric series bound to the wrong device is worse than a
 * missing one - it is wrong and it looks fine.
 *
 * INTERFACES ARE WORSE, in two specific ways.
 *
 * First, `ifIndex` is only stable across a reboot if someone enabled ifIndex
 * persistence. Where they did not, a reload silently renumbers every port, and
 * a metric series keeps flowing while quietly describing a different cable.
 * `ifIndexStable` records which devices we can trust that way; where we cannot,
 * we resolve by name and treat the index as a hint.
 *
 * Second, Cisco abbreviates in syslog but not in SNMP. The same port is
 * `Gi1/0/1` in a log line and `GigabitEthernet1/0/1` in an ifName varbind, and
 * an exact-match lookup silently fails to correlate the two feeds - the trap
 * and the log line land as two unrelated events on two nonexistent interfaces.
 * `canonicalInterfaceName` exists solely to stop that.
 */
import type {
  Device, DeviceId, InterfaceId, NetworkInterface, SiteId, TenantId, VendorId,
} from './types.ts';

// ---------------------------------------------------------------------------
// Interface naming
// ---------------------------------------------------------------------------

/**
 * Cisco's abbreviations, expanded.
 *
 * Longest-prefix wins, which is why this is an ordered list rather than an
 * object: `Te` must be tried before `T`, and the already-expanded forms must be
 * tried before their own abbreviations, or `GigabitEthernet1/0/1` matches the
 * `Gi` entry and becomes `GigabitEthernetgabitEthernet1/0/1`.
 */
const CISCO_ABBREVIATIONS: Array<[abbrev: string, full: string]> = [
  ['TwentyFiveGigE', 'TwentyFiveGigE'],
  ['TenGigabitEthernet', 'TenGigabitEthernet'],
  ['GigabitEthernet', 'GigabitEthernet'],
  ['FastEthernet', 'FastEthernet'],
  ['Port-channel', 'Port-channel'],
  ['HundredGigE', 'HundredGigE'],
  ['FortyGigE', 'FortyGigE'],
  ['Loopback', 'Loopback'],
  ['Ethernet', 'Ethernet'],
  ['Vlan', 'Vlan'],
  ['Twe', 'TwentyFiveGigE'],
  ['Hun', 'HundredGigE'],
  ['Fo', 'FortyGigE'],
  ['Te', 'TenGigabitEthernet'],
  ['Gi', 'GigabitEthernet'],
  ['Fa', 'FastEthernet'],
  ['Po', 'Port-channel'],
  ['Lo', 'Loopback'],
  ['Vl', 'Vlan'],
  ['Eth', 'Ethernet'],
  ['Et', 'Ethernet'],
];

/**
 * Expand a vendor's interface name to its canonical form.
 *
 * Deliberately NOT a cross-vendor scheme. `ge-0/0/1` stays `ge-0/0/1` and
 * `1/1/1` stays `1/1/1`, because inventing a universal port name would be
 * over-modelling and would take away the string an operator can actually paste
 * into a terminal. The only job here is making one vendor agree with itself
 * across its own feeds.
 */
export function canonicalInterfaceName(vendor: VendorId, raw: string): string {
  const name = raw.trim();
  if (vendor !== 'cisco') return name;

  for (const [abbrev, full] of CISCO_ABBREVIATIONS) {
    if (!name.startsWith(abbrev)) continue;
    const rest = name.slice(abbrev.length);
    // Only expand when what follows is the port numbering. Otherwise `Vlan10`
    // and a hypothetical `Voice1` both start with `V` and one becomes wrong.
    if (rest.length > 0 && !/^[0-9]/.test(rest)) continue;
    return full + rest;
  }
  return name;
}

// ---------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------

/**
 * An indexed view of one tenant's estate.
 *
 * Built once per normaliser invocation and thrown away. In production the
 * source is DynamoDB - a table of devices with an alias GSI - reconciled from
 * the controllers and from LLDP by a separate discovery job. Deliberately NOT
 * a live lookup per record: at push-feed rates that is one GetItem per syslog
 * line, which costs more than the pipeline it feeds.
 */
export class Inventory {
  readonly tenantId: TenantId;
  #devices = new Map<DeviceId, Device>();
  #interfaces = new Map<InterfaceId, NetworkInterface>();
  /** alias value (lowercased) -> deviceId */
  #byAlias = new Map<string, DeviceId>();
  /** deviceId + '|' + canonical name -> interfaceId */
  #byName = new Map<string, InterfaceId>();
  /** deviceId + '|' + ifIndex -> interfaceId. Only for devices we trust. */
  #byIfIndex = new Map<string, InterfaceId>();
  /** Aliases claimed by more than one device. Never resolved; always reported. */
  readonly ambiguousAliases: string[] = [];

  constructor(tenantId: TenantId, devices: Device[], interfaces: NetworkInterface[]) {
    this.tenantId = tenantId;

    for (const d of devices) {
      this.#devices.set(d.deviceId, d);
      for (const alias of d.aliases) {
        const key = alias.value.trim().toLowerCase();
        const existing = this.#byAlias.get(key);
        if (existing && existing !== d.deviceId) {
          // Two devices claiming one name is a real and recurring situation - a
          // hostname reused after a hardware swap, or two branches that both
          // called their switch `sw1`. Guessing produces telemetry silently
          // attributed to the wrong box, so we refuse to resolve it at all and
          // surface it instead.
          this.ambiguousAliases.push(key);
          continue;
        }
        this.#byAlias.set(key, d.deviceId);
      }
    }

    for (const i of interfaces) {
      this.#interfaces.set(i.interfaceId, i);
      const device = this.#devices.get(i.deviceId);
      const vendor = device ? device.vendor : 'cisco';
      this.#byName.set(i.deviceId + '|' + canonicalInterfaceName(vendor, i.name), i.interfaceId);
      if (i.ifIndex !== undefined && i.ifIndexStable) {
        this.#byIfIndex.set(i.deviceId + '|' + String(i.ifIndex), i.interfaceId);
      }
    }
  }

  device(id: DeviceId): Device | undefined { return this.#devices.get(id); }
  interface(id: InterfaceId): NetworkInterface | undefined { return this.#interfaces.get(id); }

  devices(): Device[] { return [...this.#devices.values()]; }
  interfaces(): NetworkInterface[] { return [...this.#interfaces.values()]; }

  /** Everything hanging directly off this device, from LLDP/CDP. */
  downstreamOf(deviceId: DeviceId): Device[] {
    return this.devices().filter((d) => d.uplinkDeviceId === deviceId);
  }

  /**
   * Resolve whatever the wire called this device.
   *
   * Case-insensitive because syslog hostnames and SNMP sysName routinely
   * disagree about capitalisation for the same box.
   */
  resolveDevice(claimed: string): DeviceId | undefined {
    if (!claimed) return undefined;
    const key = claimed.trim().toLowerCase();
    if (this.ambiguousAliases.includes(key)) return undefined;
    return this.#byAlias.get(key);
  }

  /**
   * Resolve an interface, by name first and index second.
   *
   * ORDER MATTERS. Name is the durable identifier; ifIndex is a number the
   * device is free to reassign on its next reload. Preferring the index because
   * it arrives as an integer and looks more like a key is the mistake that puts
   * a fortnight of counters on the wrong port.
   */
  resolveInterface(
    deviceId: DeviceId,
    opts: { name?: string; ifIndex?: number },
  ): InterfaceId | undefined {
    const device = this.#devices.get(deviceId);
    if (!device) return undefined;

    if (opts.name) {
      const hit = this.#byName.get(
        deviceId + '|' + canonicalInterfaceName(device.vendor, opts.name),
      );
      if (hit) return hit;
    }
    if (opts.ifIndex !== undefined) {
      return this.#byIfIndex.get(deviceId + '|' + String(opts.ifIndex));
    }
    return undefined;
  }

  /** The site a device sits in, for observations that carry one. */
  siteOf(deviceId: DeviceId): SiteId | undefined {
    return this.#devices.get(deviceId)?.siteId;
  }
}
