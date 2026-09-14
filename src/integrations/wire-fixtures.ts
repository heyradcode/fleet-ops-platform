/**
 * Wire fixtures: a small three-vendor estate and the traffic it emits.
 *
 * PROVENANCE. These payloads are modelled from published documentation and RFC
 * 5424/3164, not captured from live equipment. The Cisco mnemonics and the
 * Junos event tags are stable documented identifiers; the AOS-CX message
 * wording is the least well covered publicly and should be checked against a
 * real switch before anyone depends on it. Same rule the fleet fixtures follow:
 * model from references, never imply captured data.
 *
 * The estate is deliberately tiny and deliberately awkward. One device is
 * reached by three different names, one interface is abbreviated in one feed
 * and spelled out in another, one device has unstable ifIndex, and one line is
 * truncated. Those are not edge cases invented for the tests - they are the
 * four things that actually go wrong.
 */
import type { Device, NetworkInterface, Site } from '../platform/types.ts';
import type { RawBatch } from './wire.ts';

export const TENANT = 'acme-networks';

export const SITES: Site[] = [
  { tenantId: TENANT, siteId: 'dal-01', name: 'Dallas HQ', region: 'us-south', lon: -96.7970, lat: 32.7767, headcount: 1200 },
  { tenantId: TENANT, siteId: 'aus-01', name: 'Austin Campus', region: 'us-south', lon: -97.7431, lat: 30.2672, headcount: 640 },
];

export const DEVICES: Device[] = [
  {
    tenantId: TENANT,
    deviceId: 'dev-core-dal-01',
    siteId: 'dal-01',
    vendor: 'cisco',
    platform: 'ios-xe',
    name: 'core-sw-dal-01',
    role: 'core',
    // THREE names for one box, which is the normal case and not a contrived
    // one: syslog was configured with the short hostname, SNMP reports the
    // fully-qualified sysName, and the trap's source address is a third string
    // again. All three must land on the same deviceId or the two feeds never
    // corroborate each other.
    aliases: [
      { kind: 'syslog-hostname', value: 'core-sw-dal-01' },
      { kind: 'snmp-sysname', value: 'core-sw-dal-01.acme.internal' },
      { kind: 'mgmt-ip', value: '10.12.0.4' },
    ],
  },
  {
    tenantId: TENANT,
    deviceId: 'dev-edge-aus-01',
    siteId: 'aus-01',
    vendor: 'juniper',
    platform: 'junos',
    name: 'edge-rtr-aus-01',
    role: 'wan-edge',
    aliases: [
      { kind: 'syslog-hostname', value: 'edge-rtr-aus-01' },
      { kind: 'mgmt-ip', value: '10.20.0.1' },
    ],
  },
  {
    tenantId: TENANT,
    deviceId: 'dev-acc-dal-07',
    siteId: 'dal-01',
    vendor: 'aruba',
    platform: 'aos-cx',
    name: 'acc-sw-dal-07',
    role: 'access',
    // Hangs off the core switch. This is what lets a core failure explain the
    // access switch going quiet instead of raising a second unrelated incident.
    uplinkDeviceId: 'dev-core-dal-01',
    aliases: [
      { kind: 'syslog-hostname', value: 'acc-sw-dal-07' },
      { kind: 'mgmt-ip', value: '10.12.7.7' },
    ],
  },
];

export const INTERFACES: NetworkInterface[] = [
  {
    tenantId: TENANT,
    interfaceId: 'if-core-dal-01-gi1-0-1',
    deviceId: 'dev-core-dal-01',
    // Canonical long form. Syslog will call this `Gi1/0/1` on some releases and
    // SNMP always calls it `GigabitEthernet1/0/1`; both have to resolve here.
    name: 'GigabitEthernet1/0/1',
    ifIndex: 10001,
    ifIndexStable: true,        // `snmp-server ifindex persist` is configured
    speedMbps: 1_000,
    description: 'uplink to acc-sw-dal-07',
  },
  {
    tenantId: TENANT,
    interfaceId: 'if-edge-aus-01-ge-0-0-1',
    deviceId: 'dev-edge-aus-01',
    name: 'ge-0/0/1',
    ifIndex: 528,
    // NOT persistent. The index is recorded because it arrives in the trap, but
    // it must never be the thing we resolve on - a reload renumbers it and the
    // counters silently continue against a different cable.
    ifIndexStable: false,
    speedMbps: 1_000,
  },
  {
    tenantId: TENANT,
    interfaceId: 'if-acc-dal-07-1-1-1',
    deviceId: 'dev-acc-dal-07',
    name: '1/1/1',
    ifIndexStable: false,
    speedMbps: 1_000,
  },
];

/**
 * One syslog object, as a collector would have written it.
 *
 * Mixed vendors in one batch on purpose: they all arrive on the same UDP port
 * and land in the same prefix, so the normaliser has to sort them out per
 * record rather than per file.
 */
export const syslogBatch: RawBatch = {
  tenantId: TENANT,
  encoding: 'syslog',
  receivedAt: '2026-09-08T14:30:02.400Z',
  source: { collector: 'vector-use1-3' },
  records: [
    // Cisco, RFC 5424, long interface name. Note the four NILVALUEs and the
    // bare '-' where structured data would go.
    '<187>1 2026-09-08T14:30:02.123Z core-sw-dal-01 - - - - %LINK-3-UPDOWN: Interface GigabitEthernet1/0/1, changed state to down',

    // Cisco, RFC 3164, ABBREVIATED interface name and a sequence number. No
    // year and no timezone in that timestamp - it gets reconstructed.
    '<189>Sep  8 14:30:02 core-sw-dal-01 1247: %LINEPROTO-5-UPDOWN: Line protocol on Interface Gi1/0/1, changed state to down',

    // Junos, with the facts in structured data rather than in the prose.
    '<28>1 2026-09-08T14:30:02.451Z edge-rtr-aus-01 mib2d 2104 SNMP_TRAP_LINK_DOWN [junos@2636.1.1.1.2.29 ifIndex="528" ifAdminStatus="up(1)" ifOperStatus="down(2)" ifName="ge-0/0/1"] ifIndex 528, ifName ge-0/0/1',

    // Aruba AOS-CX: no useful MSGID, so the daemon in APP-NAME is the handle.
    '<147>1 2026-09-08T14:30:03.002Z acc-sw-dal-07 ops-switchd 1832 - - Interface 1/1/1 is now down',

    // A device nobody has put in the inventory. Must be COUNTED, not dropped
    // in silence - an estate whose syslog half fails to resolve looks exactly
    // like a quiet estate.
    '<187>1 2026-09-08T14:30:03.100Z rogue-sw-99 - - - - %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down',

    // Truncated mid-datagram, which UDP does routinely. Must not throw and must
    // not cost the rest of the batch.
    '<187>1 2026-09-08T14:30:03.2',

    // A Cisco message no mapper handles. Unclaimed is the normal, correct
    // outcome for the majority of what a real estate emits.
    '<190>1 2026-09-08T14:30:03.300Z core-sw-dal-01 - - - - %DHCPD-4-PING_CONFLICT: DHCP address conflict on 10.12.9.44',

    // The link coming back up. PRI 187 is syslog severity 3 - "error" - which
    // is what Cisco stamps on a link transition either way. Proof that we
    // derive severity rather than believing the device.
    '<187>1 2026-09-08T14:30:04.900Z core-sw-dal-01 - - - - %LINK-3-UPDOWN: Interface GigabitEthernet1/0/1, changed state to up',
  ],
};

/**
 * The SNMP trap for the SAME link failure as the first syslog line.
 *
 * Arrives milliseconds apart, from the same agent on the same box, and carries
 * nothing Cisco-specific anywhere in it - the trap OID is the generic
 * SNMPv2-MIB linkDown. The vendor is known because the inventory knows what
 * that device is, and the two records collapse because they produce the same
 * dedupe key. One event, two witnesses, not two independent signals.
 */
export const snmpBatch: RawBatch = {
  tenantId: TENANT,
  encoding: 'snmp-trap',
  receivedAt: '2026-09-08T14:30:02.600Z',
  source: { collector: 'vector-use1-3', address: '10.12.0.4' },
  records: [
    {
      source: '10.12.0.4',
      trapOid: '1.3.6.1.6.3.1.1.5.3',            // linkDown
      varbinds: [
        { oid: '1.3.6.1.2.1.1.5.0', value: 'core-sw-dal-01.acme.internal' },
        { oid: '1.3.6.1.2.1.2.2.1.1.10001', value: 10001 },
        { oid: '1.3.6.1.2.1.2.2.1.7.10001', value: 1 },      // ifAdminStatus up
        { oid: '1.3.6.1.2.1.2.2.1.8.10001', value: 2 },      // ifOperStatus down
        { oid: '1.3.6.1.2.1.31.1.1.1.1.10001', value: 'GigabitEthernet1/0/1' },
      ],
    },
  ],
};

/**
 * A device whose clock is a month out - not rare, and the reason every mapper
 * reconciles three timestamps instead of trusting one.
 */
export const skewedBatch: RawBatch = {
  tenantId: TENANT,
  encoding: 'syslog',
  receivedAt: '2026-09-08T14:30:02.400Z',
  source: { collector: 'vector-use1-3' },
  records: [
    '<187>1 2026-08-08T09:15:00.000Z core-sw-dal-01 - - - - %LINK-3-UPDOWN: Interface GigabitEthernet1/0/1, changed state to down',
  ],
};
