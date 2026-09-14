/**
 * Cisco IOS-XE, over syslog.
 *
 * Look at how little is here. The RFC 5424 and 3164 framing, the PRI, the
 * structured data, the reconstructed timestamp, the id hashing, the severity
 * rule and the dedupe key are all somewhere else. What is left is the only part
 * that is actually Cisco: which mnemonic means what, and where in the English
 * sentence the interface name is hiding.
 *
 * THE INTERFACE NAME IS ABBREVIATED HERE AND NOT IN SNMP. `%LINK-3-UPDOWN` says
 * `GigabitEthernet1/0/1` on some releases and `Gi1/0/1` on others, while the
 * ifName varbind for the same port always says the long form. We hand whatever
 * we found to `resolveInterface`, which canonicalises before looking up - see
 * platform/inventory.ts. Skipping that step makes the trap and the log line
 * resolve to two different interfaces, and the two feeds silently stop
 * corroborating each other.
 */
import type { DecodedRecord, MapContext, Mapper } from '../wire.ts';
import type { Observation } from '../../platform/types.ts';
import { buildEvent, type MapperIdentity } from './build.ts';

const IDENTITY: MapperIdentity = { vendor: 'cisco', platform: 'ios-xe' };

/** The mnemonics this mapper understands. Anything else is not ours. */
const HANDLED = new Set([
  'LINK-3-UPDOWN',
  'LINEPROTO-5-UPDOWN',
  'SYS-5-CONFIG_I',
  'SYS-5-RESTART',
  'SYS-5-RELOAD',
  'BGP-5-ADJCHANGE',
  'OSPF-5-ADJCHG',
]);

const INTERFACE_IN_MESSAGE = /Interface\s+([A-Za-z][A-Za-z0-9/._-]*)/;
const CHANGED_STATE = /changed state to (up|down)/i;
const BGP_NEIGHBOUR = /neighbor\s+(\S+?)\s+(Up|Down)/i;
const OSPF_NEIGHBOUR = /Nbr\s+(\S+?)\s+.*?from\s+\S+\s+to\s+(\S+)/i;

export const ciscoIosXeSyslog: Mapper = {
  ...IDENTITY,
  encoding: 'syslog',

  claims(rec: DecodedRecord): boolean {
    return HANDLED.has(rec.tag);
  },

  map(rec: DecodedRecord, ctx: MapContext): Observation[] {
    switch (rec.tag) {
      case 'LINK-3-UPDOWN':
      case 'LINEPROTO-5-UPDOWN': {
        const name = INTERFACE_IN_MESSAGE.exec(rec.raw)?.[1];
        const state = CHANGED_STATE.exec(rec.raw)?.[1]?.toLowerCase();
        if (!name || !state) return [];

        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'link-state',
          state,
          message: rec.raw,
          sourceRef: name,
          interfaceId: ctx.resolveInterface({ name }),
          attributes: {
            interfaceName: name,
            // LINK is the physical layer, LINEPROTO the protocol on top of it.
            // A cable pull raises both; a keepalive failure raises only the
            // second. Recording which one lets an operator tell those apart,
            // and the dedupe key collapses the pair when they arrive together.
            layer: rec.tag === 'LINK-3-UPDOWN' ? 'physical' : 'protocol',
          },
        })];
      }

      case 'SYS-5-CONFIG_I':
        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'config-change', state: 'committed',
          message: rec.raw, sourceRef: 'running-config',
        })];

      case 'SYS-5-RELOAD':
        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'device-restart', state: 'planned',
          message: rec.raw, sourceRef: 'chassis',
        })];

      case 'SYS-5-RESTART':
        // Logged on the way back up, and it looks identical whether the reload
        // was requested or the box crashed. Treated as unexpected here, and a
        // preceding SYS-5-RELOAD from the same device is what downgrades it -
        // a decision correlation makes, because only correlation can see both.
        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'device-restart', state: 'unexpected',
          message: rec.raw, sourceRef: 'chassis',
        })];

      case 'BGP-5-ADJCHANGE': {
        const m = BGP_NEIGHBOUR.exec(rec.raw);
        if (!m) return [];
        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'protocol-adjacency',
          state: m[2].toLowerCase() === 'up' ? 'established' : 'lost',
          message: rec.raw,
          sourceRef: 'bgp:' + m[1],
          attributes: { protocol: 'bgp', neighbour: m[1] },
        })];
      }

      case 'OSPF-5-ADJCHG': {
        const m = OSPF_NEIGHBOUR.exec(rec.raw);
        if (!m) return [];
        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'protocol-adjacency',
          state: m[2].toUpperCase() === 'FULL' ? 'established' : 'lost',
          message: rec.raw,
          sourceRef: 'ospf:' + m[1],
          attributes: { protocol: 'ospf', neighbour: m[1], ospfState: m[2] },
        })];
      }

      default:
        return [];
    }
  },
};
