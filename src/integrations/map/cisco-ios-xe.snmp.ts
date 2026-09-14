/**
 * Cisco IOS-XE, over SNMP traps.
 *
 * The same vendor as `cisco-ios-xe.syslog.ts` and the same platform, but a
 * different encoding - which is the other half of the N + M claim. Adding this
 * file changed no decoder and no other mapper, exactly as adding Juniper to
 * syslog changed no decoder and no other mapper. The two axes really are
 * independent, and that is the whole reason not to organise by vendor.
 *
 * WHY THIS MAPPER CANNOT IDENTIFY ITS OWN VENDOR, and does not need to. A
 * generic linkDown trap is OID 1.3.6.1.6.3.1.1.5.3 whoever sends it; there is
 * nothing Cisco-shaped in the record at all. The vendor comes from the
 * inventory - we resolved the source host to a device, and we know what that
 * device is - which is a far better answer than sniffing. It is also the reason
 * `claims()` is only asked "is this message family yours", never "are you the
 * right vendor".
 *
 * WHAT THIS BUYS: the same physical link failure arrives twice, once as a
 * syslog line and once as this trap, and both mappers produce the same
 * `dedupeKey`. Correlation therefore sees ONE event with two witnesses rather
 * than two independent signals - which matters, because two reports from the
 * same agent on the same box are not corroboration, they are one box saying the
 * same thing twice.
 */
import type { DecodedRecord, MapContext, Mapper } from '../wire.ts';
import type { Observation } from '../../platform/types.ts';
import { buildEvent, type MapperIdentity } from './build.ts';

const IDENTITY: MapperIdentity = { vendor: 'cisco', platform: 'ios-xe' };

const HANDLED = new Set(['linkDown', 'linkUp', 'coldStart', 'warmStart', 'authenticationFailure']);

function str(fields: Record<string, string | number | boolean>, key: string): string | undefined {
  const v = fields[key];
  return typeof v === 'string' ? v : undefined;
}

function num(fields: Record<string, string | number | boolean>, key: string): number | undefined {
  const v = fields[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

export const ciscoIosXeSnmp: Mapper = {
  ...IDENTITY,
  encoding: 'snmp-trap',

  claims(rec: DecodedRecord): boolean {
    return HANDLED.has(rec.tag);
  },

  map(rec: DecodedRecord, ctx: MapContext): Observation[] {
    switch (rec.tag) {
      case 'linkDown':
      case 'linkUp': {
        // ifName is the long form from the ifXTable; ifDescr is the older
        // object and usually says the same thing. Either resolves, because
        // canonicalInterfaceName runs on both sides of the lookup.
        const name = str(rec.fields, 'ifName') ?? str(rec.fields, 'ifDescr');
        const ifIndex = num(rec.fields, 'ifIndex');
        if (!name && ifIndex === undefined) return [];

        const state = str(rec.fields, 'ifOperStatusText')
          ?? (rec.tag === 'linkDown' ? 'down' : 'up');

        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'link-state',
          state,
          message: rec.tag + ' on ' + (name ?? ('ifIndex ' + String(ifIndex))),
          sourceRef: name ?? ('ifIndex:' + String(ifIndex)),
          interfaceId: ctx.resolveInterface({ name, ifIndex }),
          attributes: {
            interfaceName: name ?? '',
            adminStatus: str(rec.fields, 'ifAdminStatusText') ?? 'unknown',
            layer: 'physical',
          },
        })];
      }

      case 'coldStart':
        // A cold start is a power cycle or a crash: the device came up without
        // preserving state. A warm start is a software restart. The distinction
        // is the closest SNMP gets to telling us whether anyone meant it.
        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'device-restart', state: 'unexpected',
          message: 'coldStart', sourceRef: 'chassis',
        })];

      case 'warmStart':
        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'device-restart', state: 'planned',
          message: 'warmStart', sourceRef: 'chassis',
        })];

      case 'authenticationFailure':
        // An SNMP authenticationFailure means a bad community string or bad v3
        // credentials against THIS device - very often our own poller pointed at
        // it with stale credentials, which is worth knowing and is not an attack.
        return [buildEvent({
          rec, ctx, identity: IDENTITY,
          kind: 'auth-failure', state: 'rejected',
          message: 'SNMP authentication failure',
          sourceRef: 'snmp',
          attributes: { agentAddress: str(rec.fields, 'agentAddress') ?? '' },
        })];

      default:
        return [];
    }
  },
};
