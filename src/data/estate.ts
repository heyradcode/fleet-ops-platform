/**
 * The synthetic estate: five sites, sixty devices, one topology.
 *
 * All synthetic, all seeded. Two `pnpm start` runs must produce byte-identical
 * output, so every choice here comes from `platform/random.ts` with the demo
 * seed rather than from `Math.random`.
 *
 * THE SHAPE IS DELIBERATELY UNEVEN. Dallas has sixteen devices and the others
 * eleven each, because a generator that gives every site the same count hides
 * exactly the bugs worth finding - a query that accidentally returns the whole
 * estate looks correct when every partition is the same size.
 *
 * THE TOPOLOGY IS THE POINT. Each site is a two-tier tree:
 *
 *   core switch          the site's root, no uplink of its own
 *     distribution       one or two, uplinked to core
 *       access switches  uplinked to a distribution switch
 *       access points    uplinked to an access switch
 *   wan edge router      uplinked to core
 *
 * That tree is what turns forty simultaneous alarms into one incident about the
 * distribution switch that feeds them. It is the network's answer to the road
 * corridor a fleet platform would merge on, and it is a better answer: the
 * adjacency is explicitly advertised by LLDP rather than inferred from
 * coordinates.
 *
 * Real device inventories are a map of an identifiable organisation's internal
 * network. Nothing real belongs in this repo.
 */
import type {
  Device, DeviceAlias, DeviceRole, NetworkInterface, PlatformId, Site, TenantId, VendorId,
} from '../platform/types.ts';
import { random } from '../platform/random.ts';

export const DEMO_TENANT: TenantId = 'acme-networks';

export const SITES: Array<Omit<Site, 'tenantId'>> = [
  { siteId: 'dal-01', name: 'Dallas HQ',          region: 'us-south',   lon: -96.7970,  lat: 32.7767, headcount: 1_200 },
  { siteId: 'aus-01', name: 'Austin Campus',      region: 'us-south',   lon: -97.7431,  lat: 30.2672, headcount: 640 },
  { siteId: 'den-01', name: 'Denver Office',      region: 'us-west',    lon: -104.9903, lat: 39.7392, headcount: 310 },
  { siteId: 'chi-01', name: 'Chicago Datacentre', region: 'us-central', lon: -87.6298,  lat: 41.8781, headcount: 85 },
  { siteId: 'phx-01', name: 'Phoenix Branch',     region: 'us-west',    lon: -112.0740, lat: 33.4484, headcount: 140 },
];

/**
 * Which vendor each site was built with.
 *
 * Per SITE rather than per tenant, because that is how estates actually look:
 * one campus standardised on Cisco in 2019, the branch acquired in 2023 came
 * with Aruba, and nobody has had the budget to unify them. A platform that
 * assumed one vendor per customer would be wrong about most customers.
 */
const SITE_VENDOR: Record<string, { vendor: VendorId; platform: PlatformId }> = {
  'dal-01': { vendor: 'cisco', platform: 'ios-xe' },
  'aus-01': { vendor: 'juniper', platform: 'junos' },
  'den-01': { vendor: 'aruba', platform: 'aos-cx' },
  'chi-01': { vendor: 'cisco', platform: 'nx-os' },
  'phx-01': { vendor: 'aruba', platform: 'aos-cx' },
};

/** Dallas is the big one. See the note above about even partitions. */
const SITE_DEVICE_COUNT: Record<string, number> = {
  'dal-01': 16, 'aus-01': 11, 'den-01': 11, 'chi-01': 11, 'phx-01': 11,
};

/**
 * Interface naming, per vendor.
 *
 * Three genuinely different schemes, and keeping them apart here is what makes
 * `canonicalInterfaceName` worth testing: if the generator invented one uniform
 * name, the abbreviation bug this platform exists to avoid could never occur in
 * the demo data.
 */
function interfaceName(vendor: VendorId, index: number): string {
  switch (vendor) {
    case 'cisco':   return 'GigabitEthernet1/0/' + String(index);
    case 'juniper': return 'ge-0/0/' + String(index);
    case 'aruba':   return '1/1/' + String(index);
  }
}

function aliasesFor(name: string, ip: string, serial: string, role: DeviceRole): DeviceAlias[] {
  const aliases: DeviceAlias[] = [
    { kind: 'syslog-hostname', value: name },
    { kind: 'snmp-sysname', value: name + '.acme.internal' },
    { kind: 'mgmt-ip', value: ip },
  ];
  // Only the access layer and the APs are cloud-managed in this estate, so only
  // those carry a controller id. A device with no controller alias has no
  // second plane, which is the situation the corroboration rule must survive.
  if (role === 'access' || role === 'wireless-ap') {
    aliases.push({ kind: 'controller-id', value: serial });
  }
  return aliases;
}

/**
 * The "US South" service region, as a GeoJSON linear ring.
 *
 * Remember: [lon, lat], and the ring must be closed (last == first). Dallas and
 * Austin fall inside; Denver, Chicago and Phoenix do not - which is what makes
 * a point-in-polygon test in the demo prove something rather than pass
 * vacuously.
 */
export const US_SOUTH_REGION: Array<[number, number]> = [
  [-106.0, 25.5],
  [-93.0, 25.5],
  [-93.0, 36.5],
  [-106.0, 36.5],
  [-106.0, 25.5],
];

export type Estate = {
  sites: Site[];
  devices: Device[];
  interfaces: NetworkInterface[];
};

/**
 * Build the estate.
 *
 * Called once at startup and cached. The randomness is seeded, so calling it
 * twice in one process produces the same estate only if the seed is reset -
 * which `demo.ts` and the test setup both do.
 */
export function generateEstate(tenantId: TenantId = DEMO_TENANT): Estate {
  const sites: Site[] = SITES.map((s) => ({ ...s, tenantId }));
  const devices: Device[] = [];
  const interfaces: NetworkInterface[] = [];

  let octet = 10;

  for (const site of sites) {
    const { vendor, platform } = SITE_VENDOR[site.siteId];
    const total = SITE_DEVICE_COUNT[site.siteId];
    const short = site.siteId.replace('-', '');

    const mk = (role: DeviceRole, n: number, uplinkDeviceId?: string): Device => {
      const name = role.slice(0, 3) + '-' + short + '-' + String(n).padStart(2, '0');
      const deviceId = 'dev-' + name;
      const ip = '10.' + String(octet) + '.0.' + String(n);
      const serial = 'SN' + short.toUpperCase() + String(n).padStart(4, '0');

      const device: Device = {
        tenantId, deviceId, siteId: site.siteId, vendor, platform,
        name, role, uplinkDeviceId,
        aliases: aliasesFor(name, ip, serial, role),
      };
      devices.push(device);

      // Interface counts are role-shaped: an access switch has ports, an access
      // point has a single uplink. Modelling that keeps utilisation figures
      // plausible instead of uniform.
      const portCount = role === 'wireless-ap' ? 1 : role === 'access' ? 8 : 4;
      for (let p = 1; p <= portCount; p++) {
        interfaces.push({
          tenantId,
          interfaceId: 'if-' + name + '-' + String(p),
          deviceId,
          name: interfaceName(vendor, p),
          ifIndex: 10_000 + p,
          // Only Cisco kit in this estate has had ifIndex persistence turned
          // on. The rest is resolvable by name only - which is what the
          // inventory has to cope with, and does.
          ifIndexStable: vendor === 'cisco',
          speedMbps: role === 'core' || role === 'wan-edge' ? 10_000 : 1_000,
          description: role === 'access' ? 'access port' : 'uplink',
        });
      }
      return device;
    };

    octet++;

    const core = mk('core', 1);
    mk('wan-edge', 2, core.deviceId);

    const distCount = total >= 16 ? 2 : 1;
    const dists: Device[] = [];
    for (let d = 1; d <= distCount; d++) dists.push(mk('distribution', 2 + d, core.deviceId));

    let n = 2 + distCount + 1;
    let remaining = total - 2 - distCount;

    // Access switches, spread across the distribution layer, then access points
    // hanging off those switches. The spread is what makes a single
    // distribution failure explain a specific subset rather than the whole site.
    const accessCount = Math.max(1, Math.floor(remaining / 2));
    const accesses: Device[] = [];
    for (let a = 0; a < accessCount; a++) {
      const parent = dists[a % dists.length];
      accesses.push(mk('access', n++, parent.deviceId));
      remaining--;
    }

    while (remaining > 0) {
      const parent = accesses[remaining % accesses.length];
      mk('wireless-ap', n++, parent.deviceId);
      remaining--;
    }
  }

  // One shuffle pass, seeded, so the arrays are not in a suspiciously perfect
  // order when a test or the board reads them. Uses the injected random for the
  // same determinism reason as everything else here.
  for (let i = devices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [devices[i], devices[j]] = [devices[j], devices[i]];
  }

  return { sites, devices, interfaces };
}
