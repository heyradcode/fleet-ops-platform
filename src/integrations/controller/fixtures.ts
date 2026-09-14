/**
 * Cloud API payloads, modelled from published API references.
 *
 * PROVENANCE, and the same rule the whole repo follows: these are shaped from
 * the vendors' public documentation, not captured from live accounts. Meraki,
 * Mist and Aruba Central all gate API access behind a customer contract. Say so
 * if you add one; do not imply captured data.
 *
 * THE DEVICE IDENTIFIERS MATTER MORE THAN THEY LOOK. Each cloud has its OWN
 * handle for a box - Meraki a serial, Mist a MAC, Central a serial again - and
 * none of them is the hostname on the device. That is exactly the join the
 * inventory exists to make, and these fixtures use the serials
 * `data/estate.ts` registers as `controller-id` aliases so the lookup actually
 * has to do the work rather than matching on a name by luck.
 *
 * They also deliberately disagree across planes in one place: Meraki's device
 * log reports `acc-dal01-05`'s port going down (the switch's own observation),
 * and Meraki's status endpoint reports the same device offline (the cloud's
 * observation). Two planes, one cloud, one HTTPS call each - which is the
 * corroboration the whole model now rests on.
 */
import type { HttpPage, PageCursor } from '../http.ts';

/** Meraki: GET /organizations/{organizationId}/devices/statuses — CONTROLLER plane. */
export const merakiDeviceStatuses = {
  data: [
    {
      name: 'acc-dal01-05',
      serial: 'SNDAL010005',
      mac: '00:18:0a:11:22:33',
      status: 'offline',
      lastReportedAt: '2026-09-08T14:29:40.000Z',
      networkId: 'N_dal_01',
      productType: 'switch',
      model: 'MS225-48',
    },
    {
      name: 'wir-dal01-11',
      serial: 'SNDAL010011',
      mac: '00:18:0a:44:55:66',
      status: 'online',
      lastReportedAt: '2026-09-08T14:30:01.000Z',
      networkId: 'N_dal_01',
      productType: 'wireless',
      model: 'MR46',
    },
    {
      name: 'wir-dal01-12',
      serial: 'SNDAL010012',
      mac: '00:18:0a:77:88:99',
      status: 'alerting',
      lastReportedAt: '2026-09-08T14:30:02.000Z',
      networkId: 'N_dal_01',
      productType: 'wireless',
      model: 'MR46',
    },
  ],
};

/**
 * Meraki: GET /networks/{networkId}/events — DEVICE plane.
 *
 * The switch's own event log, relayed by the cloud. Same API key, same HTTPS
 * call as the statuses endpoint above, completely different vantage point.
 */
export const merakiDeviceEvents = {
  events: [
    {
      occurredAt: '2026-09-08T14:29:38.000Z',
      deviceSerial: 'SNDAL010005',
      deviceName: 'acc-dal01-05',
      type: 'port_down',
      description: 'Port 8 down',
      eventData: { port: '8' },
    },
    {
      occurredAt: '2026-09-08T14:28:10.000Z',
      deviceSerial: 'SNDAL010011',
      deviceName: 'wir-dal01-11',
      type: 'settings_changed',
      description: 'Configuration updated',
      eventData: { port: '' },
    },
    {
      // A type nothing maps. Dropping it is the normal case - these feeds carry
      // a great deal that is not operationally interesting.
      occurredAt: '2026-09-08T14:27:00.000Z',
      deviceSerial: 'SNDAL010011',
      deviceName: 'wir-dal01-11',
      type: 'dhcp_lease',
      description: 'DHCP lease issued',
      eventData: { port: '' },
    },
  ],
};

/** Mist: GET /api/v1/sites/{site_id}/stats/devices — CONTROLLER plane. */
export const mistDeviceStats = {
  results: [
    {
      name: 'wir-aus01-08',
      mac: 'SNAUS010008',
      type: 'ap',
      status: 'connected',
      num_clients: 46,
      cpu_util: 31,
      uptime: 998_112,
      // UNIX SECONDS, not milliseconds and not ISO-8601. See the note in
      // mist.ts about what getting this wrong looks like.
      last_seen: 1_788_957_000,
    },
    {
      name: 'wir-aus01-09',
      mac: 'SNAUS010009',
      type: 'ap',
      status: 'disconnected',
      num_clients: 0,
      cpu_util: 0,
      uptime: 0,
      last_seen: 1_788_956_940,
    },
  ],
};

/** Aruba Central: GET /monitoring/v2/switches — CONTROLLER plane. */
export const arubaCentralSwitches = {
  switches: [
    {
      name: 'acc-den01-04',
      serial: 'SNDEN010004',
      macaddr: '00:0b:86:aa:bb:cc',
      status: 'Down',
      site: 'Denver Office',
      cpu_utilization: 0,
      uptime: 0,
      model: 'CX 6300M',
    },
    {
      name: 'acc-den01-05',
      serial: 'SNDEN010005',
      macaddr: '00:0b:86:dd:ee:ff',
      status: 'Up',
      site: 'Denver Office',
      // Above the critical line, so the capacity rule has something real to
      // fire on and the board's load strip has something to turn red.
      cpu_utilization: 96,
      uptime: 1_884_221,
      model: 'CX 6300M',
    },
  ],
};

/** A Meraki webhook delivery, as the cloud would POST it. */
export const merakiWebhookAlert = {
  alertType: 'port_down',
  deviceSerial: 'SNDAL010005',
  deviceName: 'acc-dal01-05',
  occurredAt: '2026-09-08T14:29:38.000Z',
  alertData: { port: '8' },
};

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * Serve one page of a fixture, honouring whichever pagination dialect was asked
 * for.
 *
 * DELIBERATELY PAGES AT TWO ROWS. A fixture that fits in one page would let a
 * pagination bug through every test in the suite - the loop would run once,
 * return everything, and pass. Two-row pages mean every connector genuinely
 * paginates on every run, and a cursor that fails to advance is caught by the
 * demo rather than in production against a real estate.
 */
export const PAGE_SIZE = 2;

export function pageOf(all: unknown[], cursor: PageCursor): HttpPage {
  const start = offsetFrom(cursor);
  const records = all.slice(start, start + PAGE_SIZE);
  const nextStart = start + PAGE_SIZE;
  const done = nextStart >= all.length;

  if (done) return { records, next: { kind: 'done' } };

  switch (cursor.kind) {
    case 'link-header':
      return { records, next: { kind: 'link-header', next: '?startingAfter=' + String(nextStart) } };
    case 'page':
      return { records, next: { kind: 'page', page: cursor.page + 1, limit: cursor.limit } };
    case 'offset':
      return { records, next: { kind: 'offset', offset: nextStart, limit: cursor.limit } };
    default:
      return { records, next: { kind: 'done' } };
  }
}

function offsetFrom(cursor: PageCursor): number {
  switch (cursor.kind) {
    case 'link-header': {
      const m = /startingAfter=(\d+)/.exec(cursor.next);
      return m ? Number(m[1]) : 0;
    }
    // ONE-indexed, per the Mist header note. Treating page 1 as offset PAGE_SIZE
    // is the off-by-one that silently drops the first page of every estate.
    case 'page': return Math.max(0, cursor.page - 1) * cursor.limit;
    case 'offset': return cursor.offset;
    default: return 0;
  }
}

/**
 * Deterministic failure injection, so the demo can show a circuit breaker
 * opening without waiting for a real outage.
 *
 * Driven by an explicit set rather than by randomness: `pnpm start` twice must
 * produce identical output, and a connector that fails one run in five makes
 * the demo undiffable.
 */
const FAILING = new Set<string>();

export function failNext(controller: string): void { FAILING.add(controller); }
export function clearFailures(): void { FAILING.clear(); }

export function maybeFail(controller: string): void {
  if (FAILING.has(controller)) {
    FAILING.delete(controller);
    throw new Error('simulated ' + controller + ' outage');
  }
}
