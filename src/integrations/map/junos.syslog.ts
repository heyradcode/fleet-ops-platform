/**
 * Junos, over syslog.
 *
 * The interesting comparison is with the Cisco mapper next door. Cisco tells
 * you an interface went down in an English sentence and leaves you to find the
 * port name inside it with a regular expression. Junos puts the same facts in
 * RFC 5424 structured data:
 *
 *   [junos@2636.1.1.1.2.29 ifIndex="528" ifAdminStatus="up(1)"
 *    ifOperStatus="down(2)" ifName="ge-0/0/1"]
 *
 * which the shared decoder has already turned into fields. So this mapper reads
 * values where the Cisco one scrapes prose, and it is the more robust of the
 * two for exactly that reason: Cisco's wording changes between releases and
 * takes the regex with it, whereas an SD key is part of the interface contract.
 *
 * Both still fall back to the message text, because Junos does not put
 * everything in SD and older releases put less.
 */
import type { DecodedRecord, MapContext, Mapper } from '../wire.ts';
import type { Observation } from '../../platform/types.ts';
import { buildEvent, type MapperIdentity } from './build.ts';

const IDENTITY: MapperIdentity = { vendor: 'juniper', platform: 'junos' };

const HANDLED = new Set([
  'SNMP_TRAP_LINK_DOWN',
  'SNMP_TRAP_LINK_UP',
  'RPD_BGP_NEIGHBOR_STATE_CHANGED',
  'RPD_OSPF_NBRUP',
  'RPD_OSPF_NBRDOWN',
  'UI_COMMIT_COMPLETED',
  'SSHD_LOGIN_FAILED',
]);

/** Junos writes enumerations as `down(2)`. We want the word, not the number. */
function enumWord(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return /^([A-Za-z]+)/.exec(raw)?.[1]?.toLowerCase();
}

function str(fields: Record<string, string | number | boolean>, key: string): string | undefined {
  const v = fields[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

const BGP_IN_TEXT = /BGP peer (\S+?)\s.*changed state from \S+ to (\S+)/i;
const OSPF_IN_TEXT = /nbr\s+(\S+)/i;

export const junosSyslog: Mapper = {
  ...IDENTITY,
  encoding: 'syslog',

  claims(rec: DecodedRecord): boolean {
    return HANDLED.has(rec.tag);
  },

  map(rec: DecodedRecord, ctx: MapContext): Observation[] {
    switch (rec.tag) {
      case 'SNMP_TRAP_LINK_DOWN':
      case 'SNMP_TRAP_LINK_UP': {
        const name = str(rec.fields, 'ifName');
        const ifIndexRaw = str(rec.fields, 'ifIndex');
        const ifIndex = ifIndexRaw === undefined ? undefined : Number(ifIndexRaw);

        // Prefer what the device reported over what the tag implies. They agree
        // almost always, and when they do not - a flap where the trap for the
        // down was delayed behind the up - ifOperStatus is the one describing
        // the state the port is actually in.
        const state = enumWord(rec.fields.ifOperStatus)
          ?? (rec.tag === 'SNMP_TRAP_LINK_DOWN' ? 'down' : 'up');

        if (!name && ifIndex === undefined) return [];

        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'link-state',
          // lowerLayerDown and dormant are real ifOperStatus values and neither
          // is 'down'. Collapsing them here would lose the distinction between
          // "this port failed" and "the thing underneath it failed", which is
          // the difference between a cause and a symptom.
          state,
          message: rec.raw,
          sourceRef: name ?? ('ifIndex:' + String(ifIndex)),
          interfaceId: ctx.resolveInterface({ name, ifIndex: Number.isNaN(ifIndex) ? undefined : ifIndex }),
          attributes: {
            interfaceName: name ?? '',
            adminStatus: enumWord(rec.fields.ifAdminStatus) ?? 'unknown',
          },
        })];
      }

      case 'RPD_BGP_NEIGHBOR_STATE_CHANGED': {
        const neighbour = str(rec.fields, 'neighbor-address')
          ?? BGP_IN_TEXT.exec(rec.raw)?.[1];
        const newState = str(rec.fields, 'new-state')
          ?? BGP_IN_TEXT.exec(rec.raw)?.[2];
        if (!neighbour || !newState) return [];

        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'protocol-adjacency',
          state: newState.toLowerCase() === 'established' ? 'established' : 'lost',
          message: rec.raw,
          sourceRef: 'bgp:' + neighbour,
          attributes: { protocol: 'bgp', neighbour, bgpState: newState },
        })];
      }

      case 'RPD_OSPF_NBRUP':
      case 'RPD_OSPF_NBRDOWN': {
        const neighbour = str(rec.fields, 'neighbor') ?? OSPF_IN_TEXT.exec(rec.raw)?.[1];
        if (!neighbour) return [];

        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'protocol-adjacency',
          state: rec.tag === 'RPD_OSPF_NBRUP' ? 'established' : 'lost',
          message: rec.raw,
          sourceRef: 'ospf:' + neighbour,
          attributes: { protocol: 'ospf', neighbour },
        })];
      }

      case 'UI_COMMIT_COMPLETED':
        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'config-change', state: 'committed',
          message: rec.raw, sourceRef: 'candidate-config',
          attributes: { user: str(rec.fields, 'username') ?? 'unknown' },
        })];

      case 'SSHD_LOGIN_FAILED':
        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'auth-failure', state: 'rejected',
          message: rec.raw, sourceRef: 'sshd',
          attributes: { user: str(rec.fields, 'username') ?? 'unknown' },
        })];

      default:
        return [];
    }
  },
};
