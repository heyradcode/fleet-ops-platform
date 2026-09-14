/**
 * Cisco Meraki Dashboard API.
 *
 * Auth:  X-Cisco-Meraki-API-Key header (a long-lived key -> Secrets Manager).
 * Rate:  5 requests/second per ORGANISATION - shared by every integration that
 *        customer runs, not just ours. 429 with Retry-After.
 * Paging: an opaque URL in a `Link: <...>; rel=next` header. NOT page numbers,
 *        and the cursor must be passed back verbatim - parsing it and rebuilding
 *        the query works until Meraki changes the encoding, at which point you
 *        silently fetch page one forever.
 *
 * Real call:
 *   const res = await fetch(
 *     'https://api.meraki.com/api/v1/organizations/' + orgId + '/devices/statuses',
 *     { headers: { 'X-Cisco-Meraki-API-Key': key, Accept: 'application/json' } },
 *   );
 *   if (!res.ok) throw new ProviderError('meraki', res.status, await res.text());
 *   const next = parseLinkHeader(res.headers.get('Link'));
 *
 * Shape modelled from the published Meraki API reference; not captured from a
 * live account. See fixtures.ts.
 *
 * TWO ENDPOINTS, TWO PLANES, ONE CLOUD - and this file is the clearest example
 * of why `plane` can no longer be derived from the transport:
 *
 *   /devices/statuses   is the CLOUD's opinion. `status: 'offline'` means the
 *                       device stopped checking in WITH MERAKI. Meraki inferred
 *                       it; the device said nothing.
 *   /networks/{id}/events is the DEVICE's own event log, relayed. The switch
 *                       detected the port going down and reported it upward.
 *
 * Both arrive over the same HTTPS call with the same API key. One is a second
 * witness to the other, and a platform that called them both `controller`
 * because they both came from a REST endpoint would be unable to tell that -
 * it would hold back every alarm as uncorroborated.
 */
import type { Connector, ConnectorContext, Resource } from '../connector.ts';
import type { Inventory } from '../../platform/inventory.ts';
import type { Observation } from '../../platform/types.ts';
import type { HttpPage, PageCursor, RawBatch } from '../http.ts';
import { nowIso } from '../../platform/clock.ts';
import { controllerMetric, controllerEvent, type ControllerIdentity } from './build.ts';
import { merakiDeviceStatuses, merakiDeviceEvents, maybeFail, pageOf } from './fixtures.ts';

const IDENTITY = (tenantId: string): ControllerIdentity =>
  ({ vendor: 'cisco', platform: 'meraki', tenantId });

/**
 * The cloud's view of whether it can still see each device.
 *
 * CONTROLLER plane: Meraki is reporting its own observation, not relaying the
 * device's. That distinction is the whole reason this is a separate resource
 * from the event log rather than more rows on the same one.
 */
const deviceStatuses: Resource = {
  name: 'device-statuses',
  plane: 'controller',
  firstPage: () => ({ kind: 'link-header', next: '/organizations/ORG/devices/statuses' }),
  async fetchPage(_ctx: ConnectorContext, cursor: PageCursor): Promise<HttpPage> {
    maybeFail('meraki');
    return pageOf(merakiDeviceStatuses.data, cursor);
  },
};

/**
 * The devices' own event logs, relayed by the cloud.
 *
 * DEVICE plane: the switch detected this and told Meraki. Meraki is a courier
 * here, not a witness, and treating it as one would be double-counting.
 */
const deviceEvents: Resource = {
  name: 'device-events',
  plane: 'device',
  firstPage: () => ({ kind: 'link-header', next: '/networks/NET/events' }),
  async fetchPage(_ctx: ConnectorContext, cursor: PageCursor): Promise<HttpPage> {
    maybeFail('meraki');
    return pageOf(merakiDeviceEvents.events, cursor);
  },
};

type StatusRow = (typeof merakiDeviceStatuses)['data'][number];
type EventRow = (typeof merakiDeviceEvents)['events'][number];

export const meraki: Connector = {
  controller: 'meraki',
  vendor: 'cisco',
  platform: 'meraki',
  auth: 'api-key-header',
  rateLimitPerMin: 300,
  resources: [deviceStatuses, deviceEvents],

  normalise(raw: RawBatch, inventory: Inventory, resource: Resource): Observation[] {
    const identity = IDENTITY(raw.tenantId);
    const out: Observation[] = [];

    for (const record of raw.records) {
      if (resource.name === 'device-statuses') {
        const d = record as StatusRow;

        // The serial is Meraki's handle, not ours. It resolves only because the
        // estate records it as a controller-id alias; keying on it directly is
        // what leaves one box represented twice under two different names.
        const deviceId = inventory.resolveDeviceAny(d.serial, d.name);
        if (!deviceId) continue;
        const siteId = inventory.siteOf(deviceId);

        out.push(controllerMetric({
          identity, plane: resource.plane, encoding: raw.encoding,
          deviceId, siteId,
          sourceRef: d.serial,
          kind: 'reachability',
          value: d.status === 'online' ? 1 : 0,
          unit: 'boolean',
          observedAt: d.lastReportedAt,
          receivedAt: raw.receivedAt,
          attributes: { model: d.model, productType: d.productType, merakiStatus: d.status },
        }));

        // 'alerting' is Meraki's own word for "up but unhappy", and it does not
        // map onto reachable/unreachable at all. Recording it as an event
        // rather than forcing it into the reachability scalar is the
        // metric/event fork doing its job.
        if (d.status === 'alerting') {
          out.push(controllerEvent({
            identity, plane: resource.plane, encoding: raw.encoding,
            deviceId, siteId,
            sourceRef: d.serial,
            kind: 'power-supply', state: 'failed',
            message: 'Meraki reports device alerting',
            observedAt: d.lastReportedAt,
            receivedAt: raw.receivedAt,
          }));
        }
        continue;
      }

      if (resource.name === 'device-events') {
        const e = record as EventRow;
        const deviceId = inventory.resolveDeviceAny(e.deviceSerial, e.deviceName);
        if (!deviceId) continue;

        const mapped = mapEvent(e);
        if (!mapped) continue;

        out.push(controllerEvent({
          identity, plane: resource.plane, encoding: raw.encoding,
          deviceId,
          siteId: inventory.siteOf(deviceId),
          sourceRef: e.deviceSerial,
          kind: mapped.kind,
          state: mapped.state,
          message: e.description,
          observedAt: e.occurredAt,
          receivedAt: raw.receivedAt,
          attributes: { merakiType: e.type, port: e.eventData?.port ?? '' },
        }));
      }
    }

    return out;
  },

  /**
   * An alert pushed by Meraki the moment it fires.
   *
   * Same vocabulary as the polled event log, mapped by the same table - which
   * is exactly why poll and push live on one connector. The observations are
   * indistinguishable downstream apart from `encoding`, so the dedupe key
   * collapses the webhook and the poll's later re-report into one record.
   */
  onWebhook(raw: RawBatch, inventory: Inventory): Observation[] {
    const identity = IDENTITY(raw.tenantId);
    const out: Observation[] = [];

    for (const record of raw.records) {
      const alert = record as {
        alertType?: string; deviceSerial?: string; deviceName?: string;
        occurredAt?: string; alertData?: { port?: string };
      };
      if (!alert.deviceSerial && !alert.deviceName) continue;

      const deviceId = inventory.resolveDeviceAny(alert.deviceSerial, alert.deviceName);
      if (!deviceId) continue;

      const mapped = mapEvent({ type: alert.alertType ?? '', eventData: alert.alertData });
      if (!mapped) continue;

      out.push(controllerEvent({
        identity,
        // A webhook alert about a port is still the DEVICE's observation; the
        // cloud only forwarded it faster. The plane follows the origin, and the
        // origin did not change because the delivery did.
        plane: 'device',
        encoding: raw.encoding,
        deviceId,
        siteId: inventory.siteOf(deviceId),
        sourceRef: alert.deviceSerial ?? alert.deviceName ?? '',
        kind: mapped.kind,
        state: mapped.state,
        message: 'Meraki alert ' + (alert.alertType ?? 'unknown'),
        observedAt: alert.occurredAt ?? raw.receivedAt,
        receivedAt: raw.receivedAt,
        attributes: { merakiType: alert.alertType ?? '', delivery: 'webhook' },
      }));
    }

    return out;
  },
};

/**
 * Meraki's event vocabulary -> ours.
 *
 * The ONLY vendor-specific knowledge in this file, which is the shape every
 * connector should converge on. Anything not in the table returns undefined and
 * is dropped - these feeds carry a great deal that is not operationally
 * interesting, and inventing a mapping for an unrecognised type is how noise
 * gets onto a board.
 */
function mapEvent(
  e: { type: string; eventData?: { port?: string } },
): { kind: 'link-state' | 'device-restart' | 'config-change' | 'auth-failure'; state: string } | undefined {
  switch (e.type) {
    case 'port_down': return { kind: 'link-state', state: 'down' };
    case 'port_up': return { kind: 'link-state', state: 'up' };
    case 'device_rebooted': return { kind: 'device-restart', state: 'unexpected' };
    case 'settings_changed': return { kind: 'config-change', state: 'committed' };
    case '8021x_auth_failure': return { kind: 'auth-failure', state: 'rejected' };
    default: return undefined;
  }
}
