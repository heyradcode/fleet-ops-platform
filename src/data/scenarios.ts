/**
 * Six situations, each proving exactly one claim the architecture rests on.
 *
 * They emit VENDOR-SHAPED CLOUD PAYLOADS - the JSON Meraki, Mist and Central
 * actually return, and the JSON Meraki actually POSTs - rather than pre-built
 * Observations, so every scenario travels the same
 * fetch -> normalise -> collapse -> evaluate -> correlate path production
 * traffic does. A scenario that hand-built its own observations would prove
 * that the rules work on data the rules already agree with, which is worth
 * nothing.
 *
 * Devices are selected BY ROLE AND VENDOR from the generated estate rather than
 * named literally, so a change to the generator cannot silently leave a
 * scenario pointing at a device that no longer exists - it fails loudly instead.
 *
 * THE FIRST SCENARIO CHANGED MEANING when the feeds became cloud-only, and it
 * is worth knowing why. It used to show a syslog line and an SNMP trap from one
 * switch - two records, one agent. There is no SNMP any more, but the identical
 * trap is still available: one Meraki alert arrives by webhook the instant it
 * fires AND again in the polled event log a few minutes later. Two records, two
 * transports, one witness. The rule that catches it is the same rule.
 *
 * Fixtures are modelled from published references, not captured from live
 * accounts. Real device inventories are a map of an identifiable
 * organisation's internal network; nothing real belongs in this repo.
 */
import type { Device, DeviceRole, SiteId } from '../platform/types.ts';
import type { ControllerId } from '../integrations/connector.ts';
import type { Estate } from './estate.ts';

/**
 * One page of one endpoint, or one webhook delivery.
 *
 * `resource` names the endpoint the rows came from, because that is what
 * carries the PLANE - and the plane is what corroboration reads. `'webhook'`
 * means an inbound delivery, which goes through signature verification before
 * anything looks at it.
 */
export type ScenarioFeed = {
  controller: ControllerId;
  resource: string;
  records: unknown[];
};

export type Scenario = {
  id: string;
  title: string;
  /** The one claim this scenario exists to demonstrate. */
  proves: string;
  /** What the operator should see afterwards, in one line. */
  expect: string;
  feeds: ScenarioFeed[];
  /** Devices the synthetic prober should report as unreachable. */
  unreachable?: string[];
};

const AT = '2026-09-08T14:30:00.000Z';

function at(offsetSeconds: number): string {
  return new Date(Date.parse(AT) + offsetSeconds * 1_000).toISOString();
}

function pick(estate: Estate, siteId: SiteId, role: DeviceRole, nth = 0): Device {
  const matches = estate.devices
    .filter((d) => d.siteId === siteId && d.role === role)
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  const device = matches[nth];
  if (!device) {
    throw new Error(
      'scenario needs a ' + role + ' at ' + siteId + ' (#' + nth + ') and the estate has ' +
      matches.length + '. Fix the scenario or the generator, do not paper over it.',
    );
  }
  return device;
}

function pickVendor(estate: Estate, vendor: Device['vendor'], role?: DeviceRole): Device {
  const device = estate.devices
    .filter((d) => d.vendor === vendor && (role ? d.role === role : d.role !== 'wireless-ap'))
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId))[0];
  if (!device) {
    throw new Error(
      'scenario needs a ' + vendor + ' device and the estate has none. ' +
      'Fix the scenario or the generator, do not paper over it.',
    );
  }
  return device;
}

/** The handle a cloud knows this device by. Not its hostname - that is the point. */
function controllerId(device: Device): string {
  return device.aliases.find((a) => a.kind === 'controller-id')?.value ?? device.name;
}

/** A row from Meraki's device event log. DEVICE plane: the switch saw this. */
function merakiEvent(device: Device, type: string, when: string, port = '1') {
  return {
    occurredAt: when,
    deviceSerial: controllerId(device),
    deviceName: device.name,
    type,
    description: type.replace(/_/g, ' ') + ' on port ' + port,
    eventData: { port },
  };
}

/** A row from Meraki's device status endpoint. CONTROLLER plane: Meraki's opinion. */
function merakiStatus(device: Device, status: 'online' | 'offline' | 'alerting', when: string) {
  return {
    name: device.name,
    serial: controllerId(device),
    mac: '00:18:0a:00:00:01',
    status,
    lastReportedAt: when,
    networkId: 'N_' + device.siteId,
    productType: device.role === 'wireless-ap' ? 'wireless' : 'switch',
    model: 'MS225-48',
  };
}

/** A Meraki webhook delivery. Same event, faster, and possibly twice. */
function merakiAlert(device: Device, alertType: string, when: string, port = '1') {
  return {
    alertType,
    deviceSerial: controllerId(device),
    deviceName: device.name,
    occurredAt: when,
    alertData: { port },
  };
}

export function buildScenarios(estate: Estate): Scenario[] {
  const dallas = 'dal-01';

  const core = pick(estate, dallas, 'core');
  const dist = pick(estate, dallas, 'distribution');
  const access = pick(estate, dallas, 'access');
  const access2 = pick(estate, dallas, 'access', 1);

  // One device from each of the other two vendors, for the mixed-estate
  // scenario. Selected by VENDOR rather than by name, so the scenario keeps
  // proving what it claims even if the generator renames or re-sites things.
  const junos = pickVendor(estate, 'juniper', 'wireless-ap');
  const aruba = pickVendor(estate, 'aruba', 'access');

  // Everything downstream of the distribution switch, which is what the cascade
  // scenario expects to collapse into one incident.
  const downstream = estate.devices.filter((d) => d.uplinkDeviceId === dist.deviceId);

  const scenarios: Scenario[] = [
    {
      id: 'double-report',
      title: 'One port failure, delivered twice by one cloud',
      proves:
        'A webhook and the polled event log that later re-reports the same alert ' +
        'are ONE event with two records, not two witnesses. They share a dedupe ' +
        'key and collapse before the rules ever see them.',
      expect: 'two raw records, one event, and NOT enough on its own to page anyone',
      feeds: [
        // The webhook, the instant it fired.
        { controller: 'meraki', resource: 'webhook', records: [merakiAlert(core, 'port_down', at(0))] },
        // The poll, a few minutes later, carrying the same event again. This is
        // the normal consequence of an overlapping watermark, not a bug.
        { controller: 'meraki', resource: 'device-events', records: [merakiEvent(core, 'port_down', at(0))] },
      ],
    },

    {
      id: 'cross-plane',
      title: 'The same failure, seen from three different vantage points',
      proves:
        'Corroboration means independent PLANES, not independent transports. The ' +
        'switch reported the port down, the cloud separately noticed the device ' +
        'stopped checking in, and our own probe cannot reach it. Three vantage ' +
        'points - two of them from ONE vendor over ONE API key.',
      expect: 'an incident opens, because the evidence is genuinely independent',
      feeds: [
        { controller: 'meraki', resource: 'device-events', records: [merakiEvent(access, 'port_down', at(0))] },
        { controller: 'meraki', resource: 'device-statuses', records: [merakiStatus(access, 'offline', at(1))] },
      ],
      // The probe is the third plane, and the only one that works when a device
      // has stopped talking altogether - or when the vendor's API is the thing
      // having a bad morning.
      unreachable: [access.deviceId],
    },

    {
      id: 'cascade',
      title: 'A distribution switch dies and takes its subtree with it',
      proves:
        'Topology merge. One failure produces an alarm on every device beneath ' +
        'it; they collapse into ONE incident that names the switch to go and ' +
        'look at, rather than paging once per orphaned device.',
      expect:
        'one incident naming ' + dist.name + ' as root cause, not ' +
        String(downstream.length + 1) + ' separate pages',
      feeds: [
        {
          controller: 'meraki',
          resource: 'device-statuses',
          records: [
            merakiStatus(dist, 'offline', at(0)),
            ...downstream.map((d) => merakiStatus(d, 'offline', at(1))),
          ],
        },
      ],
      unreachable: [dist.deviceId, ...downstream.map((d) => d.deviceId)],
    },

    {
      id: 'lone-signal',
      title: 'One access port flaps and nothing else agrees',
      proves:
        'The noise filter. A single uncorroborated alarm is recorded and shown, ' +
        'but does not page. This is the case that makes the other five ' +
        'trustworthy - a board that alerts on everything gets ignored.',
      expect: 'an alarm on the board, no incident, nobody woken',
      feeds: [
        { controller: 'meraki', resource: 'device-events', records: [merakiEvent(access2, 'port_down', at(0))] },
      ],
    },

    {
      id: 'mixed-estate',
      title: 'Three clouds describing the same kind of event',
      proves:
        'One canonical model. Meraki says "offline", Mist says "disconnected" ' +
        'and Central says "Down" - three vocabularies for one idea, arriving ' +
        'over three different pagination dialects, landing as identical ' +
        'Observations under one severity rule.',
      expect: 'three clouds, one shape, one severity rule applied to all of them',
      feeds: [
        { controller: 'meraki', resource: 'device-statuses', records: [merakiStatus(core, 'offline', at(0))] },
        {
          controller: 'mist',
          resource: 'device-stats',
          records: [{
            name: junos.name,
            mac: controllerId(junos),
            type: 'ap',
            status: 'disconnected',
            num_clients: 0,
            cpu_util: 0,
            uptime: 0,
            // UNIX SECONDS. Getting this wrong files the AP's status in 1970.
            last_seen: Math.floor(Date.parse(at(0)) / 1000),
          }],
        },
        {
          controller: 'aruba-central',
          resource: 'switches',
          records: [{
            name: aruba.name,
            serial: controllerId(aruba),
            macaddr: '00:0b:86:aa:bb:cc',
            status: 'Down',
            site: aruba.siteId,
            cpu_utilization: 0,
            uptime: 0,
            model: 'CX 6300M',
          }],
        },
      ],
    },

    {
      id: 'stale-inventory',
      title: 'A cloud returns a device nobody registered',
      proves:
        'Unresolved devices are COUNTED and named, never dropped in silence. An ' +
        'estate whose cloud feed half fails to resolve looks exactly like a ' +
        'quiet estate, and that is the most dangerous failure mode this ' +
        'pipeline has.',
      expect: 'the record is dropped, the serial is reported, and the number is visible',
      feeds: [
        {
          controller: 'meraki',
          resource: 'device-statuses',
          records: [{
            name: 'sw-nobody-registered-01',
            serial: 'SNUNKNOWN0001',
            mac: '00:18:0a:ff:ff:ff',
            status: 'offline',
            lastReportedAt: at(0),
            networkId: 'N_dal_01',
            productType: 'switch',
            model: 'MS225-48',
          }],
        },
      ],
    },
  ];

  // Only where there IS a Houston - the HHS estate. Acme has none, and its
  // feeds would skip a SolarWinds batch anyway: Acme runs no SolarWinds.
  if (estate.sites.some((s) => s.siteId === 'hou-01')) scenarios.push(wanDegraded(estate));
  // And only where there IS a data centre with SBCs behind its switches.
  if (estate.sites.some((s) => s.siteId === 'adc-01')) scenarios.push(sbcPathDegraded(estate));
  return scenarios;
}

/** SolarWinds interface rows for one device: up, and erroring hard. */
function erroringPort(estate: Estate, device: Device, ids: { interfaceId: number; nodeId: number }) {
  const alias = (kind: string) => device.aliases.find((a) => a.kind === kind)?.value ?? '';
  const port = estate.interfaces.find((i) => i.deviceId === device.deviceId);
  if (!port) throw new Error('scenario needs an interface on ' + device.name + '. Fix the generator.');
  return {
    InterfaceID: ids.interfaceId, NodeID: ids.nodeId,
    NodeCaption: alias('snmp-sysname'), NodeIPAddress: alias('mgmt-ip'),
    Name: port.name, OperStatus: 1, AdminStatus: 1,
    // Up, and erroring: at 14:30, half an hour's total that averages
    // ~1,300 per five-minute poll against a critical line of 1,000.
    InErrorsThisHour: 7_900, OutErrorsThisHour: 60,
    LastSync: '2026-09-08T09:29:40.0000000',
  };
}

/**
 * Houston's WAN edge drops packets while Houston's calls go bad.
 *
 * The seventh situation, and the only one about the knowledge graph (docs/12,
 * Part 3). The network half is deliberately WEAK: one witness - SNMP error
 * counters, relayed by SolarWinds, the DEVICE plane - so the rules hold it
 * back and nobody is paged, exactly as for the lone port flap. The comms half
 * is already planted: poor call quality at Houston Regional (LC=1120), from
 * Teams and Webex agreeing. What joins them is the building - the WAN edge is
 * LOCATED_AT facility 1120 - and what comes of the join is a CANDIDATE, never
 * evidence: it promotes nothing, suppresses nothing, pages nobody.
 */
function wanDegraded(estate: Estate): Scenario {
  const wan = pick(estate, 'hou-01', 'wan-edge');
  return {
    id: 'wan-degraded',
    title: 'A WAN edge drops packets, and only the box itself says so',
    proves:
      'One witness still does not page. But a held-back signal in the RIGHT ' +
      'BUILDING is what the knowledge graph puts next to that building\'s ' +
      'call-quality incident - as a candidate cause, never as evidence.',
    expect: 'held back on the network board; the top candidate cause on Houston\'s call-quality incident',
    feeds: [{
      controller: 'solarwinds',
      resource: 'interfaces',
      records: [erroringPort(estate, wan, { interfaceId: 71001, nodeId: 2101 })],
    }],
  };
}

/**
 * The switch SBC2 is plugged into drops packets while SBC2 fails calls.
 *
 * The eighth situation, and the trunk half of the graph's claim. The comms
 * half is already planted: most calls through sbc2 fail with 503s, Teams and
 * Bandwidth agreeing. No building joins them - an SBC is not a facility - so
 * what joins them is the `sbcSwitch` table: SBC2 RUNS_ON this access switch,
 * which uplinks to the data centre's core. The switch beside it, SBC1's, is
 * the same model on the same parent and is NOT on SBC2's path: a fault there
 * would never be offered as SBC2's cause. Held back, like the WAN edge - one
 * witness - and a candidate, never evidence.
 */
function sbcPathDegraded(estate: Estate): Scenario {
  // SBC2's switch is the SECOND access switch (`sbcSwitch` in the comms
  // config names it by hostname). By role and position, never by literal
  // name: a generator change fails the graph tests loudly instead.
  const access = pick(estate, 'adc-01', 'access', 1);
  return {
    id: 'sbc-path-degraded',
    title: 'The switch in front of an SBC drops packets, and only the box itself says so',
    proves:
      'A failing trunk is not a building, so it is the SBC\'s own path - its ' +
      'switch, up to the core, out through the WAN edge - that the graph ' +
      'searches for its candidates. The switch beside it is not on that path.',
    expect: 'held back on the network board; the top candidate cause on sbc2\'s failing-trunk incident',
    feeds: [{
      controller: 'solarwinds',
      resource: 'interfaces',
      records: [erroringPort(estate, access, { interfaceId: 71002, nodeId: 2102 })],
    }],
  };
}
