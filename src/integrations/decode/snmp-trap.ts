/**
 * The SNMP trap decoder.
 *
 * The second encoding, and the one that proves the split is on the right axis:
 * adding it did not touch the syslog decoder, and adding Juniper to syslog did
 * not touch this. Encoding and vendor really are independent.
 *
 * WHAT ARRIVES HERE IS ALREADY JSON. A trap is BER-encoded binary on the wire,
 * and decoding that would need `Buffer`, which the browser build forbids. The
 * constraint pushes us somewhere better anyway: the collector does the binary
 * work - it has the MIBs, it handles v2c versus v3, it deduplicates
 * retransmissions - and writes varbinds as OID/value pairs. What is left is the
 * genuinely ambiguous part, which is deciding what those OIDs MEAN, and that is
 * the job worth owning.
 *
 * TRAPS HAVE NO CLOCK. A trap carries sysUpTime - ticks since the device booted
 * - and no wall-clock time at all. So `claimedTime` is always undefined here,
 * `observedAt` always falls back to the collector's arrival time, and the whole
 * class of broken-NTP problems that plagues syslog simply does not arise. Worth
 * knowing when a trap and a syslog line disagree about when something happened:
 * the trap is not the one that is lying.
 *
 * UNKNOWN OIDS ARE KEPT, NOT DROPPED. The table below covers IF-MIB and the
 * generic v2 traps, which is most of what matters, but all three vendors extend
 * the space with their own enterprise branches. An OID we cannot name is still
 * evidence, so it is passed through verbatim under its numeric form rather than
 * discarded for being unrecognised.
 */
import type { Decoder, DecodedRecord, RawBatch } from '../wire.ts';

/** Generic SNMPv2 notifications, 1.3.6.1.6.3.1.1.5.x. */
const TRAP_NAMES: Record<string, string> = {
  '1.3.6.1.6.3.1.1.5.1': 'coldStart',
  '1.3.6.1.6.3.1.1.5.2': 'warmStart',
  '1.3.6.1.6.3.1.1.5.3': 'linkDown',
  '1.3.6.1.6.3.1.1.5.4': 'linkUp',
  '1.3.6.1.6.3.1.1.5.5': 'authenticationFailure',
};

/**
 * The IF-MIB objects worth naming, plus sysName.
 *
 * Longest prefix wins - ifName lives under the ifXTable at
 * 1.3.6.1.2.1.31.1.1.1.1 while ifIndex is 1.3.6.1.2.1.2.2.1.1, and matching
 * short would put one under the other.
 */
const OID_NAMES: Array<[prefix: string, name: string]> = [
  ['1.3.6.1.2.1.31.1.1.1.18', 'ifAlias'],
  ['1.3.6.1.2.1.31.1.1.1.10', 'ifHCOutOctets'],
  ['1.3.6.1.2.1.31.1.1.1.6', 'ifHCInOctets'],
  ['1.3.6.1.2.1.31.1.1.1.15', 'ifHighSpeed'],
  ['1.3.6.1.2.1.31.1.1.1.1', 'ifName'],
  ['1.3.6.1.2.1.2.2.1.1', 'ifIndex'],
  ['1.3.6.1.2.1.2.2.1.2', 'ifDescr'],
  ['1.3.6.1.2.1.2.2.1.3', 'ifType'],
  ['1.3.6.1.2.1.2.2.1.5', 'ifSpeed'],
  ['1.3.6.1.2.1.2.2.1.7', 'ifAdminStatus'],
  ['1.3.6.1.2.1.2.2.1.8', 'ifOperStatus'],
  ['1.3.6.1.2.1.1.5', 'sysName'],
  ['1.3.6.1.2.1.1.3', 'sysUpTime'],
  ['1.3.6.1.2.1.1.1', 'sysDescr'],
];

/** Enterprise branches, so an unnamed trap can at least be attributed. */
const ENTERPRISES: Array<[prefix: string, vendor: string]> = [
  ['1.3.6.1.4.1.9.', 'cisco'],
  ['1.3.6.1.4.1.2636.', 'juniper'],
  ['1.3.6.1.4.1.14823.', 'aruba'],
];

/**
 * IF-MIB enumerations, spelled out.
 *
 * `ifOperStatus 2` is a number in the varbind and 'down' to everyone reading a
 * board. Resolving it here rather than in each mapper means Cisco and Juniper
 * cannot end up disagreeing about what 7 means - it is `lowerLayerDown` in the
 * MIB and therefore in both.
 */
const IF_STATUS: Record<number, string> = {
  1: 'up', 2: 'down', 3: 'testing',
  4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown',
};

type Varbind = { oid: string; value: string | number | boolean };

/** Strip the instance suffix: `1.3.6.1.2.1.2.2.1.8.528` is ifOperStatus for ifIndex 528. */
function nameFor(oid: string): { name: string; instance?: string } {
  for (const [prefix, name] of OID_NAMES) {
    if (oid === prefix) return { name };
    if (oid.startsWith(prefix + '.')) return { name, instance: oid.slice(prefix.length + 1) };
  }
  return { name: oid };
}

function vendorOf(trapOid: string): string | undefined {
  for (const [prefix, vendor] of ENTERPRISES) {
    if (trapOid.startsWith(prefix)) return vendor;
  }
  return undefined;
}

function varbindsOf(record: Record<string, unknown>): Varbind[] {
  const list = record.varbinds ?? record.variables ?? record.varBinds;
  if (!Array.isArray(list)) return [];

  const out: Varbind[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const vb = entry as Record<string, unknown>;
    const oid = vb.oid ?? vb.name;
    const value = vb.value;
    if (typeof oid !== 'string') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push({ oid, value });
    }
  }
  return out;
}

export const snmpTrapDecoder: Decoder = {
  encoding: 'snmp-trap',

  decode(batch: RawBatch): DecodedRecord[] {
    const out: DecodedRecord[] = [];

    for (const record of batch.records) {
      if (!record || typeof record !== 'object') continue;
      const obj = record as Record<string, unknown>;

      const trapOid = typeof obj.trapOid === 'string' ? obj.trapOid
        : typeof obj.trap_oid === 'string' ? obj.trap_oid
          : undefined;
      if (!trapOid) continue;

      const fields: Record<string, string | number | boolean> = {};
      let sysName: string | undefined;

      for (const vb of varbindsOf(obj)) {
        const { name, instance } = nameFor(vb.oid);
        fields[name] = vb.value;
        if (instance !== undefined) fields.instance = instance;

        if (name === 'sysName' && typeof vb.value === 'string') sysName = vb.value;

        // Spell out the two enumerations anything downstream actually reads.
        if ((name === 'ifOperStatus' || name === 'ifAdminStatus') && typeof vb.value === 'number') {
          fields[name + 'Text'] = IF_STATUS[vb.value] ?? 'unknown';
        }
      }

      const address = typeof obj.source === 'string' ? obj.source
        : typeof obj.agentAddress === 'string' ? obj.agentAddress
          : batch.source.address;

      fields.trapOid = trapOid;
      const enterprise = vendorOf(trapOid);
      if (enterprise) fields.enterprise = enterprise;
      if (address) fields.agentAddress = address;

      out.push({
        encoding: 'snmp-trap',
        receivedAt: batch.receivedAt,
        // sysName when the device sent it, otherwise the source address. The
        // address is the weaker identifier - it moves on a DHCP renewal - which
        // is exactly why the inventory holds both as aliases.
        claimedHost: sysName ?? address ?? '',
        // Deliberately absent: a trap carries no wall-clock time. See the header.
        claimedTime: undefined,
        tag: TRAP_NAMES[trapOid] ?? trapOid,
        fields,
        raw: JSON.stringify(record),
      });
    }

    return out;
  },
};
