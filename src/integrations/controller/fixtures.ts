/**
 * Controller payloads, modelled from published API references.
 *
 * PROVENANCE, and the same rule the whole repo follows: these are shaped from
 * the vendors' public documentation, not captured from live accounts. Meraki,
 * Mist and Aruba Central all gate API access behind a customer contract. Say so
 * if you add one; do not imply captured data.
 *
 * THE DEVICE IDENTIFIERS MATTER MORE THAN THEY LOOK. Each controller has its
 * OWN handle for a box - Meraki a serial, Mist a MAC, Central a serial again -
 * and none of them is the hostname the same box puts in its syslog. That is
 * exactly the join the inventory exists to make, and these fixtures use the
 * serials `data/estate.ts` registers as `controller-id` aliases so the lookup
 * actually has to do the work rather than matching on a name by luck.
 *
 * They also deliberately disagree with the device plane in one place: Meraki
 * reports `acc-dal01-05` offline. That is the second witness the corroboration
 * rule needs, and without it the scenario that opens an incident would be
 * relying on the probe alone.
 */

/** Meraki: GET /organizations/{organizationId}/devices/statuses */
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

/** Mist: GET /api/v1/sites/{site_id}/stats/devices */
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

/** Aruba Central: GET /monitoring/v2/switches */
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
