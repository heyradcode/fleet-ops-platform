/**
 * Six situations, each proving exactly one claim the architecture rests on.
 *
 * They emit VENDOR-SHAPED PAYLOADS - real syslog lines, real trap varbinds -
 * rather than pre-built Observations, so every scenario travels the same
 * decode -> map -> resolve -> evaluate -> correlate path that production
 * traffic does. A scenario that hand-built its own observations would prove
 * that the rules work on data the rules already agree with, which is worth
 * nothing.
 *
 * Devices are selected BY ROLE from the generated estate rather than named
 * literally, so a change to the generator cannot silently leave a scenario
 * pointing at a device that no longer exists - it fails loudly instead.
 *
 * Fixtures are modelled from published references, not captured from live
 * accounts. Real device inventories are a map of an identifiable
 * organisation's internal network; nothing real belongs in this repo.
 */
import type { Device, DeviceRole, SiteId, TenantId } from '../platform/types.ts';
import type { RawBatch } from '../integrations/wire.ts';
import type { Estate } from './estate.ts';

export type Scenario = {
  id: string;
  title: string;
  /** The one claim this scenario exists to demonstrate. */
  proves: string;
  /** What the operator should see afterwards, in one line. */
  expect: string;
  batches: RawBatch[];
  /** Devices the synthetic prober should report as unreachable. */
  unreachable?: string[];
};

const AT = '2026-09-08T14:30:00.000Z';

function at(offsetSeconds: number): string {
  return new Date(Date.parse(AT) + offsetSeconds * 1_000).toISOString();
}

function pick(estate: Estate, siteId: SiteId, role: DeviceRole, nth = 0): Device {
  const matches = estate.devices
    .filter((d) => d.siteId === siteId && d.role === role)
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  const device = matches[nth];
  if (!device) {
    throw new Error(
      'scenario needs a ' + role + ' at ' + siteId + ' (#' + nth + ') and the estate has ' +
      matches.length + '. Fix the scenario or the generator, do not paper over it.',
    );
  }
  return device;
}

function pickVendor(estate: Estate, vendor: Device['vendor']): Device {
  const device = estate.devices
    .filter((d) => d.vendor === vendor && d.role !== 'wireless-ap')
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId))[0];
  if (!device) {
    throw new Error(
      'scenario needs a ' + vendor + ' device and the estate has none. ' +
      'Fix the scenario or the generator, do not paper over it.',
    );
  }
  return device;
}

function syslog(tenantId: TenantId, receivedAt: string, lines: string[]): RawBatch {
  return {
    tenantId,
    encoding: 'syslog',
    receivedAt,
    source: { collector: 'vector-use1-1' },
    records: lines,
  };
}

function traps(tenantId: TenantId, receivedAt: string, records: unknown[]): RawBatch {
  return {
    tenantId,
    encoding: 'snmp-trap',
    receivedAt,
    source: { collector: 'vector-use1-1' },
    records,
  };
}

/** A Cisco IOS-XE link transition, RFC 5424. */
function ciscoLink(host: string, iface: string, state: 'up' | 'down', when: string): string {
  return '<187>1 ' + when + ' ' + host + ' - - - - %LINK-3-UPDOWN: Interface ' +
    iface + ', changed state to ' + state;
}

/** The matching SNMP linkDown/linkUp trap for the same port on the same box. */
function ciscoLinkTrap(sysName: string, iface: string, ifIndex: number, down: boolean) {
  return {
    source: '10.10.0.1',
    trapOid: down ? '1.3.6.1.6.3.1.1.5.3' : '1.3.6.1.6.3.1.1.5.4',
    varbinds: [
      { oid: '1.3.6.1.2.1.1.5.0', value: sysName },
      { oid: '1.3.6.1.2.1.2.2.1.1.' + String(ifIndex), value: ifIndex },
      { oid: '1.3.6.1.2.1.2.2.1.7.' + String(ifIndex), value: 1 },
      { oid: '1.3.6.1.2.1.2.2.1.8.' + String(ifIndex), value: down ? 2 : 1 },
      { oid: '1.3.6.1.2.1.31.1.1.1.1.' + String(ifIndex), value: iface },
    ],
  };
}

function snmpName(device: Device): string {
  return device.aliases.find((a) => a.kind === 'snmp-sysname')?.value ?? device.name;
}

function firstInterface(estate: Estate, device: Device): string {
  const iface = estate.interfaces.find((i) => i.deviceId === device.deviceId);
  if (!iface) throw new Error('no interfaces generated for ' + device.deviceId);
  return iface.name;
}

export function buildScenarios(estate: Estate): Scenario[] {
  const tenantId = estate.sites[0].tenantId;
  const dallas = 'dal-01';

  const core = pick(estate, dallas, 'core');
  const dist = pick(estate, dallas, 'distribution');
  const access = pick(estate, dallas, 'access');
  const access2 = pick(estate, dallas, 'access', 1);
  const corePort = firstInterface(estate, core);
  const accessPort = firstInterface(estate, access);

  // One device from each of the other two vendors, for the mixed-estate
  // scenario. Selected by VENDOR rather than by name, so the scenario keeps
  // proving what it claims even if the generator renames or re-sites things.
  const junos = pickVendor(estate, 'juniper');
  const aruba = pickVendor(estate, 'aruba');

  // Everything downstream of the distribution switch, which is what the cascade
  // scenario expects to collapse into one incident.
  const downstream = estate.devices.filter((d) => d.uplinkDeviceId === dist.deviceId);

  return [
    {
      id: 'double-report',
      title: 'One link failure, reported twice by the same box',
      proves:
        'A syslog line and an SNMP trap from one agent are ONE event with two ' +
        'records, not two witnesses. They share a dedupe key and collapse before ' +
        'the rules ever see them.',
      expect: 'two raw records, one event, and NOT enough on its own to page anyone',
      batches: [
        syslog(tenantId, at(1), [ciscoLink(core.name, corePort, 'down', at(0))]),
        traps(tenantId, at(1), [ciscoLinkTrap(snmpName(core), corePort, 10_001, true)]),
      ],
    },

    {
      id: 'cross-plane',
      title: 'The same failure, seen from three different vantage points',
      proves:
        'Corroboration means independent PLANES. The switch says the port is ' +
        'down, its controller reports the device offline, and our own probe ' +
        'cannot reach it. Three vantage points, so this one is real.',
      expect: 'an incident opens, because the evidence is genuinely independent',
      batches: [
        syslog(tenantId, at(1), [ciscoLink(access.name, accessPort, 'down', at(0))]),
      ],
      // The probe is the third plane, and the only one that works when a device
      // has stopped talking altogether.
      unreachable: [access.deviceId],
    },

    {
      id: 'cascade',
      title: 'A distribution switch dies and takes its subtree with it',
      proves:
        'Topology merge. One failure produces an alarm on every device beneath ' +
        'it; they collapse into ONE incident that names the switch to go and ' +
        'look at, rather than paging once per orphaned device.',
      expect:
        'one incident naming ' + dist.name + ' as root cause, not ' +
        String(downstream.length + 1) + ' separate pages',
      batches: [
        syslog(tenantId, at(2), [
          ciscoLink(dist.name, firstInterface(estate, dist), 'down', at(0)),
          ...downstream.map((d) => ciscoLink(d.name, firstInterface(estate, d), 'down', at(1))),
        ]),
      ],
      unreachable: [dist.deviceId, ...downstream.map((d) => d.deviceId)],
    },

    {
      id: 'lone-signal',
      title: 'One access port flaps and nothing else agrees',
      proves:
        'The noise filter. A single uncorroborated alarm is recorded and shown, ' +
        'but does not page. This is the case that makes the other five ' +
        'trustworthy - a board that alerts on everything gets ignored.',
      expect: 'an alarm on the board, no incident, nobody woken',
      batches: [
        syslog(tenantId, at(1), [
          ciscoLink(access2.name, firstInterface(estate, access2), 'down', at(0)),
        ]),
      ],
    },

    {
      id: 'mixed-estate',
      title: 'Three vendors describing the same kind of event',
      proves:
        'One canonical model. Cisco, Junos and AOS-CX say the same thing in ' +
        'three dialects - a mnemonic, a structured-data element and an English ' +
        'sentence - and land as identical Observations.',
      expect: 'three vendors, one shape, one severity rule applied to all of them',
      batches: [
        syslog(tenantId, at(1), [
          // Cisco: the fact is inside the prose.
          ciscoLink(core.name, corePort, 'down', at(0)),
          // Junos: the fact is in structured data. The hostname and port come
          // from the estate rather than being written out here - a literal
          // would silently stop resolving the moment the generator's naming
          // changed, and the scenario would quietly prove nothing.
          '<28>1 ' + at(0) + ' ' + junos.name + ' mib2d 2104 SNMP_TRAP_LINK_DOWN ' +
          '[junos@2636.1.1.1.2.29 ifIndex="528" ifAdminStatus="up(1)" ' +
          'ifOperStatus="down(2)" ifName="' + firstInterface(estate, junos) + '"] ifName ' +
          firstInterface(estate, junos),
          // AOS-CX: the fact is in an English sentence, and the daemon is the handle.
          '<147>1 ' + at(0) + ' ' + aruba.name + ' ops-switchd 1832 - - Interface ' +
          firstInterface(estate, aruba) + ' is now down',
        ]),
      ],
    },

    {
      id: 'stale-inventory',
      title: 'A device sends syslog under a name nobody registered',
      proves:
        'Unresolved hosts are COUNTED and named, never dropped in silence. An ' +
        'estate whose syslog half fails to resolve looks exactly like a quiet ' +
        'estate, and that is the most dangerous failure mode this pipeline has.',
      expect: 'the record is dropped, the hostname is reported, and the number is visible',
      batches: [
        syslog(tenantId, at(1), [
          ciscoLink('sw-nobody-registered-01', 'GigabitEthernet1/0/9', 'down', at(0)),
        ]),
      ],
    },
  ];
}
