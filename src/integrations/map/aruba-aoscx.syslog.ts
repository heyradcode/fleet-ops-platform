/**
 * Aruba AOS-CX, over syslog.
 *
 * PROVENANCE, AND A WARNING. The Cisco mnemonics and Junos event tags in the
 * neighbouring files are stable, published identifiers that appear verbatim in
 * vendor documentation. The AOS-CX event vocabulary is the least well covered
 * of the three in public references, so the patterns below are modelled from
 * documentation rather than captured from a live switch, and the message text
 * in particular should be checked against real output before anyone relies on
 * it. Saying so is the same rule the fleet fixtures follow: model from
 * published references, and never imply captured data.
 *
 * That uncertainty shaped the design here. This mapper claims on the DAEMON
 * name in APP-NAME - `ops-switchd`, `hpe-fand` and friends - rather than on
 * exact event ids, because the daemon that emitted a line is far more stable
 * than the wording of the line itself. Where Junos hands us structured data and
 * Cisco hands us a documented mnemonic, here we are reading English, and the
 * code is written to fail closed: a message that does not match returns nothing
 * rather than guessing.
 *
 * This is what a third vendor costs once the split is right. It is one file, it
 * touches no decoder, and the two existing mappers did not change.
 */
import type { DecodedRecord, MapContext, Mapper } from '../wire.ts';
import type { Observation } from '../../platform/types.ts';
import { buildEvent, type MapperIdentity } from './build.ts';

const IDENTITY: MapperIdentity = { vendor: 'aruba', platform: 'aos-cx' };

/** AOS-CX daemons whose output is worth interpreting. */
const DAEMONS = ['ops-switchd', 'ops-lldpd', 'ops-portd', 'hpe-fand', 'hpe-poed', 'hpe-restd'];

const INTERFACE_STATE = /Interface\s+(\S+?)\s+is\s+(?:now\s+)?(up|down)\b/i;
const PSU_STATE = /(?:PSU|Power supply)\s+(\S+?)\s+(?:is\s+)?(failed|absent|ok|restored)\b/i;
const CONFIG_CHANGE = /[Cc]onfiguration (?:was )?(?:changed|committed)(?:\s+by\s+user\s+(\S+))?/;
const RADIUS_TIMEOUT = /RADIUS server\s+(\S+?)\s+(?:is\s+)?(?:unreachable|timed out)/i;

function appNameOf(rec: DecodedRecord): string {
  const app = rec.fields.appName;
  return typeof app === 'string' ? app : '';
}

export const arubaAosCxSyslog: Mapper = {
  ...IDENTITY,
  encoding: 'syslog',

  claims(rec: DecodedRecord): boolean {
    const app = appNameOf(rec);
    return DAEMONS.includes(app) || DAEMONS.includes(rec.tag);
  },

  map(rec: DecodedRecord, ctx: MapContext): Observation[] {
    const link = INTERFACE_STATE.exec(rec.raw);
    if (link) {
      const name = link[1];
      return [buildEvent({
        rec, ctx, identity: IDENTITY,
        kind: 'link-state',
        state: link[2].toLowerCase(),
        message: rec.raw,
        sourceRef: name,
        // AOS-CX port names are already canonical - `1/1/1`, `lag1`, `vlan10` -
        // so there is no expansion step here. That asymmetry with Cisco lives
        // in canonicalInterfaceName, not in this file, which is the point.
        interfaceId: ctx.resolveInterface({ name }),
        attributes: { interfaceName: name, daemon: appNameOf(rec) },
      })];
    }

    const psu = PSU_STATE.exec(rec.raw);
    if (psu) {
      const state = psu[2].toLowerCase();
      return [buildEvent({
        rec, ctx, identity: IDENTITY,
        kind: 'power-supply',
        state: state === 'ok' || state === 'restored' ? 'restored' : 'failed',
        message: rec.raw,
        sourceRef: 'psu:' + psu[1],
        attributes: { psu: psu[1], reported: state },
      })];
    }

    const radius = RADIUS_TIMEOUT.exec(rec.raw);
    if (radius) {
      return [buildEvent({
        rec, ctx, identity: IDENTITY,
        kind: 'auth-failure', state: 'server-timeout',
        message: rec.raw,
        sourceRef: 'radius:' + radius[1],
        attributes: { server: radius[1] },
      })];
    }

    const config = CONFIG_CHANGE.exec(rec.raw);
    if (config) {
      return [buildEvent({
        rec, ctx, identity: IDENTITY,
        kind: 'config-change', state: 'committed',
        message: rec.raw, sourceRef: 'running-config',
        attributes: { user: config[1] ?? 'unknown' },
      })];
    }

    return [];
  },
};
