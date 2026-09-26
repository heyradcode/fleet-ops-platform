/**
 * SolarWinds Orion (NPM), through the SolarWinds Information Service (SWIS).
 *
 * Auth:   HTTP Basic, an Orion account -> Secrets Manager.
 * Query:  SWQL, POSTed as JSON `{ query, parameters }` to
 *         `https://{orion}:17774/SolarWinds/InformationService/v3/Json/Query`.
 * Paging: `ORDER BY ... WITH ROWS m TO n` in the query - an OFFSET dialect,
 *         one-indexed and INCLUSIVE at both ends.
 *
 * Shape modelled from the published SWIS/SWQL references; not captured from
 * a live Orion. Entity property names are stable across versions but custom
 * properties are not - verify against the customer's Orion.
 *
 * NOT A CLOUD, AND IT OBSERVES FROM TWO PLANES. SolarWinds is a poller WE run
 * against the devices. What it reports depends on how it learned it:
 *
 *   node status (ICMP)   its poller pinged the box. EXTERNAL - our side's
 *                        vantage point, like the probe. And therefore the SAME
 *                        plane as the probe: a tenant running both has one
 *                        external witness, not two.
 *   CPU, interfaces      the box reported its own counters over SNMP and
 *                        SolarWinds relayed them. DEVICE plane.
 *   SolarWinds ALERTS    NOT INGESTED. They are Orion's conclusions from the
 *                        same polls; taking them as well would count one
 *                        witness twice - the double-counting the plane model
 *                        exists to prevent.
 *
 * Status is read the same way. Up, Down and Unreachable are measurements.
 * Warning and Critical are Orion's OPINION of a threshold - skipped, because
 * our own rules own thresholds. Unmanaged means someone muted the node in
 * Orion for maintenance - skipped entirely, since its "status" is stale by
 * design.
 *
 * SWQL IS A QUERY LANGUAGE, so the same rule as SPL and AR qualifications:
 * the texts are a fixed catalogue, and a value ever needed goes in
 * `parameters`, bound by SWIS, never spliced into the text. `swisRequest`
 * refuses a parameter the query does not declare.
 *
 * NO TIME FILTER, deliberately. `LastSync` columns carry NO ZONE - server
 * local time - and filtering one with a UTC watermark drops or re-reads rows
 * by the server's UTC offset, silently. These are STATE snapshots bounded by
 * the size of the estate, not event logs, so the whole state is read each poll.
 */
import type { Connector, ConnectorContext, Resource } from '../connector.ts';
import type { Inventory } from '../../platform/inventory.ts';
import type { Observation } from '../../platform/types.ts';
import type { HttpPage, PageCursor, RawBatch } from '../http.ts';
import { controllerEvent, controllerMetric, type ControllerIdentity } from './build.ts';
import { maybeFail, pageOf, solarwindsInterfaces, solarwindsNodes } from './fixtures.ts';
import { log } from '../../platform/logger.ts';

/** The SWQL catalogue. Texts are constants; see the header on parameters. */
export const SWQL = {
  nodes:
    'SELECT n.NodeID, n.Caption, n.IPAddress, n.Status, n.StatusDescription, n.UnManaged, ' +
    'n.CPULoad, n.LastSystemUpTimePollUtc FROM Orion.Nodes n ORDER BY n.NodeID WITH ROWS @first TO @last',
  interfaces:
    'SELECT i.InterfaceID, i.NodeID, i.Node.Caption AS NodeCaption, i.Node.IPAddress AS NodeIPAddress, ' +
    'i.Name, i.OperStatus, i.AdminStatus, i.LastSync FROM Orion.NPM.Interfaces i ' +
    'ORDER BY i.InterfaceID WITH ROWS @first TO @last',
} as const;

/**
 * One SWIS request. Parameters must be DECLARED in the query as `@name`;
 * anything else is refused rather than sent, so a value can never find its
 * way into a query by any route but binding.
 */
export function swisRequest(
  name: keyof typeof SWQL, parameters: Record<string, string | number>,
): { query: string; parameters: Record<string, string | number> } {
  const query = SWQL[name];
  const declared = new Set([...query.matchAll(/@(\w+)/g)].map((m) => m[1]));
  for (const p of Object.keys(parameters)) {
    if (!declared.has(p)) throw new Error('SWQL parameter @' + p + ' is not declared by query ' + name);
  }
  for (const p of declared) {
    if (!(p in parameters)) throw new Error('SWQL query ' + name + ' needs parameter @' + p);
  }
  return { query, parameters };
}

/**
 * Orion's `2026-09-08T14:29:10.1234567` - seven fractional digits, and in a
 * `...Utc` column, UTC with no designator. Trimmed to milliseconds and marked
 * UTC explicitly: `Date.parse` is not required to accept seven digits, and a
 * string with no zone is read as LOCAL time, which is the wrong answer by the
 * server's offset. Returns undefined rather than guessing.
 */
export function parseOrionUtc(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z?$/.exec(s);
  if (!m) return undefined;
  const t = Date.parse(m[1] + '.' + (m[2] ?? '0').padEnd(3, '0').slice(0, 3) + 'Z');
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** SWIS pages as `WITH ROWS m TO n` - the offset dialect, bound as parameters. */
function swisResource(
  name: string, plane: Resource['plane'], query: keyof typeof SWQL, rows: unknown[],
): Resource {
  return {
    name,
    plane,
    firstPage: () => ({ kind: 'offset', offset: 0, limit: 500 }),
    async fetchPage(_ctx: ConnectorContext, cursor: PageCursor): Promise<HttpPage> {
      maybeFail('solarwinds');
      // The request a real fetch would POST. Built here so the catalogue and
      // its parameter rule are exercised on every poll, not only in a test.
      if (cursor.kind === 'offset') {
        swisRequest(query, { first: cursor.offset + 1, last: cursor.offset + cursor.limit });
      }
      return pageOf(rows, cursor);
    },
  };
}

/** Node status by ICMP. EXTERNAL plane - see the header. */
const nodeStatus = swisResource('node-status', 'external', 'nodes', solarwindsNodes);
/** Node CPU by SNMP: the device's own counter. DEVICE plane. */
const nodeCpu = swisResource('node-cpu', 'device', 'nodes', solarwindsNodes);
/** Interface state by SNMP. DEVICE plane. */
const interfaces = swisResource('interfaces', 'device', 'interfaces', solarwindsInterfaces);

type NodeRow = (typeof solarwindsNodes)[number];
type InterfaceRow = (typeof solarwindsInterfaces)[number];

/** Orion node status codes that are MEASUREMENTS. Everything else is skipped. */
const STATUS_UP = 1;
const STATUS_DOWN = 2;
const STATUS_UNREACHABLE = 12;
/** ifOperStatus / ifAdminStatus (RFC 2863): 1 up, 2 down. */
const IF_UP = 1;
const IF_DOWN = 2;

export const solarwinds: Connector = {
  controller: 'solarwinds',
  // One connector, every vendor. Each observation carries the DEVICE's real
  // vendor and platform from the inventory - SolarWinds is the courier.
  vendor: 'multi-vendor',
  platform: 'solarwinds-orion',
  auth: 'basic',
  rateLimitPerMin: 600,
  resources: [nodeStatus, nodeCpu, interfaces],

  normalise(raw: RawBatch, inventory: Inventory, resource: Resource): Observation[] {
    const out: Observation[] = [];
    const identityOf = (deviceId: string): ControllerIdentity | undefined => {
      const d = inventory.device(deviceId);
      return d ? { vendor: d.vendor, platform: d.platform, tenantId: raw.tenantId } : undefined;
    };
    // The Caption is whatever the Orion admin typed: often the SNMP sysName,
    // sometimes a label ("DAL-WAN-EDGE"). The IP is the dependable handle.
    // One resolveDeviceAny call, so an unknown node is ONE miss, not three.
    const resolve = (caption: string, ip: string) =>
      inventory.resolveDeviceAny(caption, ip, caption.split('.')[0]);

    if (resource.name === 'interfaces') {
      for (const record of raw.records) {
        const r = record as InterfaceRow;
        // Admin-down is someone's decision. Its oper-down is expected, and an
        // alarm on it would page for every port deliberately shut.
        if (r.AdminStatus !== IF_UP) continue;
        if (r.OperStatus !== IF_UP && r.OperStatus !== IF_DOWN) continue;   // testing, dormant, ...
        const deviceId = resolve(r.NodeCaption, r.NodeIPAddress);
        if (!deviceId) continue;
        const identity = identityOf(deviceId)!;
        const interfaceId = inventory.resolveInterface(deviceId, { name: r.Name });
        const state = r.OperStatus === IF_UP ? 'up' : 'down';
        out.push({
          ...controllerEvent({
            identity, plane: resource.plane, encoding: raw.encoding,
            deviceId, siteId: inventory.siteOf(deviceId),
            sourceRef: 'I:' + r.InterfaceID,
            kind: 'link-state', state,
            message: r.Name + ' oper ' + state + ' (SNMP, via SolarWinds)',
            // `LastSync` has no zone - server-local - so it is NOT used as the
            // observation time. Our receipt time is honest; a mis-zoned one
            // would file the event hours away from its neighbours.
            observedAt: raw.receivedAt,
            receivedAt: raw.receivedAt,
            attributes: { orionInterfaceId: r.InterfaceID, orionNodeId: r.NodeID },
          }),
          interfaceId,
        });
      }
      return out;
    }

    for (const record of raw.records) {
      const r = record as NodeRow;
      if (r.UnManaged) continue;                 // muted for maintenance
      const deviceId = resolve(r.Caption, r.IPAddress);
      if (!deviceId) continue;
      const identity = identityOf(deviceId)!;
      const observedAt = parseOrionUtc(r.LastSystemUpTimePollUtc) ?? raw.receivedAt;
      const common = {
        identity, plane: resource.plane, encoding: raw.encoding,
        deviceId, siteId: inventory.siteOf(deviceId),
        sourceRef: 'N:' + r.NodeID, observedAt, receivedAt: raw.receivedAt,
        attributes: { orionNodeId: r.NodeID, orionStatus: r.StatusDescription },
      };

      if (resource.name === 'node-status') {
        if (r.Status !== STATUS_UP && r.Status !== STATUS_DOWN && r.Status !== STATUS_UNREACHABLE) {
          // Warning / Critical / Unknown: Orion's opinion, or no measurement.
          log.debug('solarwinds status skipped', { node: r.Caption, status: r.Status });
          continue;
        }
        out.push(controllerMetric({
          ...common, kind: 'reachability', value: r.Status === STATUS_UP ? 1 : 0, unit: 'boolean',
        }));
      } else if (resource.name === 'node-cpu') {
        // -2 is Orion's "unknown"; a node that is not up has no fresh CPU at all.
        if (r.Status !== STATUS_UP || r.CPULoad < 0) continue;
        out.push(controllerMetric({ ...common, kind: 'cpu-utilisation', value: r.CPULoad, unit: 'percent' }));
      }
    }
    return out;
  },
};
