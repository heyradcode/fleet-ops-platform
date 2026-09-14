/**
 * ---------------------------------------------------------------------------
 * The domain model
 * ---------------------------------------------------------------------------
 * The whole platform in one file, in the order data flows through it:
 *
 *   vendor feed -> RawBatch -> Observation -> Alarm -> Incident -> answer
 *
 * `Observation` is the *canonical* shape. Cisco, Juniper and Aruba all describe
 * the same network in different words; every mapper's job is to translate into
 * these types so the rest of the platform - correlation, GraphQL, the agent,
 * the board - only ever has to understand ONE schema.
 *
 * THE TWO-LEVEL SPLIT, and why it is not over-modelling:
 *
 *   Alarm      one entity, one rule, decided deterministically.
 *              "GigabitEthernet1/0/1 on core-sw-dal-01 is down."
 *   Incident   many alarms, corroborated and merged. This is what pages a
 *              human. "Distribution switch failure affecting 40 access points."
 *
 * Collapsing them means a failed core switch pages a NOC forty times, which is
 * how on-call teams learn to ignore the board. Keeping them apart is what makes
 * "corroborate before alerting" expressible at all.
 *
 * Note the `tenantId` on literally everything. In a multi-tenant platform the
 * tenant is not a filter you remember to add - it is part of the identity of
 * every record and the partition key of every query. See platform/tenancy.ts.
 */
import { sha256 } from './crypto.ts';

/** Opaque-ish branded IDs keep you from passing a deviceId where a tenantId goes. */
export type TenantId = string;
export type SiteId = string;
export type DeviceId = string;
export type InterfaceId = string;
export type ObservationId = string;
export type AlarmId = string;
export type IncidentId = string;

/**
 * Vendors, and the platforms underneath them.
 *
 * These are SEPARATE axes on purpose. "Cisco" is not a format - IOS-XE, NX-OS
 * and Meraki disagree with each other about message tags at least as much as
 * Cisco disagrees with Juniper. A mapper is chosen by the pair, never by the
 * vendor alone. See integrations/wire.ts.
 */
export type VendorId = 'cisco' | 'juniper' | 'aruba';

export type PlatformId =
  // Cisco: on-box network OS, then the cloud-managed estate.
  | 'ios-xe'
  | 'nx-os'
  | 'meraki'
  // Juniper: on-box, then Mist.
  | 'junos'
  | 'mist'
  // Aruba: on-box, then Central.
  | 'aos-cx'
  | 'aruba-central';

/**
 * How the bytes arrived. THIS is what selects a decoder, and it is deliberately
 * independent of the vendor - RFC 5424 syslog is RFC 5424 syslog whoever sent
 * it. Decoders are keyed by encoding, mappers by (vendor, platform, encoding),
 * which turns an N x M problem into N + M.
 */
export type Encoding =
  | 'syslog'        // UDP 514, push. RFC 5424 where we are lucky, 3164 where we are not.
  | 'snmp-trap'     // UDP 162, push. Varbinds, already decoded by the collector.
  | 'gnmi'          // gRPC over TCP, dial-out streaming telemetry.
  | 'ipfix'         // UDP, push. NetFlow v9 / IPFIX flow records.
  | 'rest-json'     // Pull or webhook, from the cloud controllers.
  | 'probe';        // Our own synthetic reachability test.

/**
 * WHO OBSERVED IT - and the single most load-bearing field in this file.
 *
 * Corroboration is the rule that decides whether an alarm is worth waking
 * someone for, and the naive version of it - "two feeds agreed" - is worthless
 * here. A link failure on a Cisco switch emits a syslog line AND an SNMP trap,
 * from the same agent, on the same box, milliseconds apart. That is one witness
 * reporting twice, not two witnesses.
 *
 * Independence means a different VANTAGE POINT:
 *
 *   device      the box told us about itself      syslog, traps, gNMI
 *   controller  its manager told us               Meraki, Mist, Aruba Central
 *   external    we observed it from outside       synthetic probe, flow absence
 *
 * The external plane matters most in the worst case: a device that is wedged or
 * powered off reports nothing at all, and only something outside it can notice.
 */
export type ObservationPlane = 'device' | 'controller' | 'external';

export type Severity = 'ok' | 'info' | 'warning' | 'critical';

export type Unit =
  | 'percent' | 'ms' | 'count' | 'seconds'
  | 'dbm' | 'celsius' | 'mbps' | 'octets' | 'packets' | 'boolean';

/**
 * What a metric measures. Drives units, thresholds and how the agent talks.
 *
 *   reachability          1 reachable, 0 not   (a probe, not a claim)
 *   cpu-utilisation       percent
 *   memory-utilisation    percent
 *   interface-utilisation percent of link speed
 *   interface-errors      errors per interval
 *   optical-rx-power      dBm, NEGATIVE, and closer to zero is better
 *   wan-latency           ms
 *   packet-loss           percent
 *   ap-client-count       associated clients on one access point
 */
export type MetricKind =
  | 'reachability'
  | 'cpu-utilisation'
  | 'memory-utilisation'
  | 'interface-utilisation'
  | 'interface-errors'
  | 'optical-rx-power'
  | 'wan-latency'
  | 'packet-loss'
  | 'ap-client-count';

/**
 * What an event reports. No value, because none of these are quantities.
 *
 * `state` carries the transition - 'up'/'down' for a link, 'established'/'lost'
 * for an adjacency. Keeping it a free string per kind rather than one global
 * union stops the type becoming a cross-product nobody can read.
 */
export type EventKind =
  | 'link-state'
  | 'protocol-adjacency'
  | 'device-restart'
  | 'config-change'
  | 'auth-failure'
  | 'power-supply'
  | 'radio-state';

/** IANA protocol numbers we bother to name. Everything else stays 'other'. */
export type FlowProtocol = 'tcp' | 'udp' | 'icmp' | 'other';

/**
 * Fields every observation carries, whatever its shape.
 *
 * THE THREE TIMESTAMPS are not redundancy, they are the fix for a real and
 * common failure. `deviceTime` is what the device claimed; network gear with
 * broken NTP is routine, and RFC 3164 syslog carries no year and no timezone at
 * all. `receivedAt` is when our collector saw it, which we actually trust.
 * `observedAt` is the reconciled answer that everything downstream sorts and
 * windows by - see `resolveObservedAt`.
 */
export type ObservationBase = {
  tenantId: TenantId;
  observationId: ObservationId;

  vendor: VendorId;
  platform: PlatformId;
  encoding: Encoding;
  /** The vantage point. Drives corroboration - see ObservationPlane. */
  plane: ObservationPlane;

  /** Resolved identity, never a vendor string. See platform/inventory.ts. */
  deviceId: DeviceId;
  interfaceId?: InterfaceId;
  siteId?: SiteId;

  /** The vendor's own handle for the subject: ifName, trap OID, test id. */
  sourceRef: string;

  /** Reconciled. Sort and window by this one. */
  observedAt: string;
  /** What the device said, when it said anything. Untrusted. */
  deviceTime?: string;
  /** When the collector received it. Trusted. */
  receivedAt: string;
  /** deviceTime - receivedAt, in ms. Small is normal; large is a broken clock. */
  clockSkewMs?: number;

  severity: Severity;
  attributes: Record<string, string | number | boolean>;
};

/**
 * THE THREE-WAY FORK, and why one shape will not do.
 *
 * Network data is not one thing, it is three, with genuinely different shapes:
 *
 *   metric  a number with a unit, sampled            CPU 84%, optical -14.2 dBm
 *   event   a discrete state transition, NO number   link down, config committed
 *   flow    an aggregate over a traffic tuple        4.2MB between two addresses
 *
 * Forcing an event into the metric shape means writing `value: 1` and then
 * inventing a threshold for it, which is how you end up with severity rules
 * that are arithmetic on a boolean. Forcing a flow in is worse: a flow has two
 * timestamps and no single subject, so `deviceId` alone cannot address it.
 *
 * WHERE THEY GO IS DIFFERENT TOO, and that is the real argument. Metrics and
 * events drive the operational path - hot state, rules, incidents. Flows do
 * not: a mid-size edge produces well over 100k flows/sec. Flows land in S3 as
 * columnar files and are queried analytically; they never touch the hot store
 * and they never reach the event bus. Keeping them a separate variant is what
 * stops someone helpfully "unifying" them into the path that cannot afford it.
 */
export type MetricObservation = ObservationBase & {
  class: 'metric';
  kind: MetricKind;
  value: number;
  unit: Unit;
};

export type EventObservation = ObservationBase & {
  class: 'event';
  kind: EventKind;
  /** The transition, e.g. 'up' | 'down'. Vocabulary is per-kind by design. */
  state: string;
  /** Human-readable, taken from the vendor. For the board and the agent. */
  message: string;
  /**
   * Collapses the SAME real-world event arriving by more than one feed.
   *
   * A link going down on a Cisco switch reliably produces a syslog line AND an
   * SNMP linkDown trap, from the same box, within milliseconds. They are one
   * event and two records, and without this key the correlation stage counts
   * them as two independent signals - which is exactly the mistake the
   * `plane` field exists to prevent. See `dedupeKeyFor`.
   */
  dedupeKey: string;
};

export type FlowObservation = ObservationBase & {
  class: 'flow';
  srcAddr: string;
  dstAddr: string;
  srcPort: number;
  dstPort: number;
  protocol: FlowProtocol;
  octets: number;
  packets: number;
  /** Flows are intervals, not instants. `observedAt` is the end of the window. */
  flowStart: string;
  flowEnd: string;
};

/** Everything downstream reads this and only this. */
export type Observation = MetricObservation | EventObservation | FlowObservation;

/** Narrowing helpers, so consumers do not hand-write the discriminant check. */
export function isMetric(o: Observation): o is MetricObservation { return o.class === 'metric'; }
export function isEvent(o: Observation): o is EventObservation { return o.class === 'event'; }
export function isFlow(o: Observation): o is FlowObservation { return o.class === 'flow'; }

/**
 * The plane a feed observes from, when nothing overrides it.
 *
 * A table rather than a field each mapper sets, because getting this wrong is
 * silent: mark a controller feed as 'device' and corroboration starts accepting
 * one witness as two.
 */
export function planeFor(encoding: Encoding): ObservationPlane {
  switch (encoding) {
    case 'syslog':
    case 'snmp-trap':
    case 'gnmi':
    case 'ipfix':
      return 'device';
    case 'rest-json':
      return 'controller';
    case 'probe':
      return 'external';
  }
}

// ---------------------------------------------------------------------------
// Identity of a record
// ---------------------------------------------------------------------------

/**
 * A CONTENT HASH, not a random id.
 *
 * Push feeds are at-least-once by nature: syslog is UDP and gets resent, traps
 * are retransmitted until acknowledged, and the S3-triggered normaliser is
 * itself retried. Hashing the identifying tuple makes the write idempotent, so
 * a replayed datagram overwrites its own row rather than creating a second.
 *
 * This is one of the most commonly asked serverless design questions:
 *   "your Lambda is retried - how do you avoid double-processing?"
 *
 * Deliberately NOT including receivedAt: two collectors behind the same load
 * balancer stamp slightly different arrival times for the same datagram, and
 * including it would defeat the whole point.
 */
export function observationId(
  vendor: VendorId, deviceId: DeviceId, sourceRef: string, kind: string, at: string,
): ObservationId {
  return sha256(vendor + '|' + deviceId + '|' + sourceRef + '|' + kind + '|' + at).slice(0, 24);
}

/**
 * The cross-feed dedupe key for an event.
 *
 * Coarser than `observationId` on purpose: it deliberately drops the vendor,
 * the encoding and the exact timestamp, because the whole job is to make a
 * syslog line and an SNMP trap describing one link failure collide. Time is
 * bucketed rather than exact for the same reason - the two feeds are
 * milliseconds apart and will never agree to the millisecond.
 */
export const DEDUPE_BUCKET_MS = 5_000;

export function dedupeKeyFor(args: {
  deviceId: DeviceId; interfaceId?: InterfaceId;
  kind: EventKind; state: string; observedAt: string;
}): string {
  const bucket = Math.floor(Date.parse(args.observedAt) / DEDUPE_BUCKET_MS);
  return [
    args.deviceId, args.interfaceId ?? '-', args.kind, args.state, String(bucket),
  ].join('|');
}

// ---------------------------------------------------------------------------
// Time reconciliation - one rule, applied by every mapper
// ---------------------------------------------------------------------------

/**
 * How far a device's clock may drift before we stop believing it.
 *
 * Five minutes sits well outside normal NTP error and well inside the point at
 * which windowing breaks. A device an hour out otherwise puts its link-down
 * event in a correlation window that has already closed, and the incident
 * simply never forms - a silent failure with no error anywhere.
 *
 * Exported because the board shows a "clock skew" badge at exactly this value.
 * One constant, so a badge cannot disagree with the rule that produced it.
 */
export const CLOCK_SKEW_LIMIT_MS = 5 * 60 * 1_000;

export type ResolvedTime = {
  observedAt: string;
  deviceTime?: string;
  receivedAt: string;
  clockSkewMs?: number;
};

/**
 * Decide which timestamp to trust.
 *
 * Prefer the device's own clock, because it is closer to the event and the
 * collector may have queued. Fall back to arrival time the moment the claim is
 * implausible - including when it is in the FUTURE, which a device with a
 * mis-set year manages easily.
 */
export function resolveObservedAt(receivedAt: string, deviceTime?: string): ResolvedTime {
  if (!deviceTime) return { observedAt: receivedAt, receivedAt };

  const claimed = Date.parse(deviceTime);
  const arrived = Date.parse(receivedAt);
  if (Number.isNaN(claimed)) return { observedAt: receivedAt, receivedAt };

  const skew = claimed - arrived;
  const trustworthy = Math.abs(skew) <= CLOCK_SKEW_LIMIT_MS;

  return {
    observedAt: trustworthy ? deviceTime : receivedAt,
    deviceTime,
    receivedAt,
    clockSkewMs: skew,
  };
}

// ---------------------------------------------------------------------------
// The estate
// ---------------------------------------------------------------------------

/** Where a name came from. Kept because provenance is what makes a clash debuggable. */
export type AliasKind =
  | 'syslog-hostname'
  | 'snmp-sysname'
  | 'mgmt-ip'
  | 'chassis-serial'
  | 'lldp-chassis-id'
  | 'controller-id';

export type DeviceAlias = { kind: AliasKind; value: string };

/**
 * Role drives severity weighting and, more importantly, the merge rule: a core
 * switch failing explains everything downstream of it, an access switch
 * explains only itself.
 */
export type DeviceRole =
  | 'core' | 'distribution' | 'access'
  | 'wan-edge' | 'wireless-ap' | 'firewall';

export type Device = {
  tenantId: TenantId;
  deviceId: DeviceId;
  siteId: SiteId;
  vendor: VendorId;
  platform: PlatformId;
  /** What operators call it. For display; never a join key. */
  name: string;
  role: DeviceRole;
  aliases: DeviceAlias[];
  /**
   * The device one hop upstream, from LLDP/CDP.
   *
   * This is the network's answer to the road corridor a fleet platform would
   * merge on: it is what lets forty access points going dark collapse into one
   * incident about the distribution switch that feeds them, instead of forty
   * pages. And it is easier than the geographic version - the adjacency graph
   * is explicitly advertised rather than inferred from coordinates.
   */
  uplinkDeviceId?: DeviceId;
};

export type NetworkInterface = {
  tenantId: TenantId;
  interfaceId: InterfaceId;
  deviceId: DeviceId;
  /** Canonical, expanded, vendor-native. `GigabitEthernet1/0/1`, not `Gi1/0/1`. */
  name: string;
  /** Present when we have polled the device. A hint, not an identity. */
  ifIndex?: number;
  /** False unless ifIndex persistence is known to be configured. Assume false. */
  ifIndexStable: boolean;
  speedMbps: number;
  description?: string;
};

/** A physical place. Lives in Aurora PostGIS; cached in DynamoDB. */
export type Site = {
  tenantId: TenantId;
  siteId: SiteId;
  name: string;
  region: string;
  lon: number;
  lat: number;
  /** People who notice when this site goes down. Weights incident severity. */
  headcount: number;
};

export type DeviceStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

/**
 * A device's current condition. THE HOT STATE.
 *
 * One item per device, overwritten on every observation. At 40k devices that is
 * 40k items regardless of how often they report - which is the whole reason
 * observation history lives in S3 instead of here.
 */
export type DeviceState = {
  tenantId: TenantId;
  deviceId: DeviceId;
  name: string;
  siteId: SiteId;
  role: DeviceRole;
  vendor: VendorId;
  status: DeviceStatus;
  /** Current position, copied from the site. Overwritten, never appended. */
  lon: number;
  lat: number;
  /** Percent. Drives the capacity-saturation rule and the board's load strip. */
  cpuUtilisation: number;
  /** How many of this device's interfaces are currently down. */
  interfacesDown: number;
  /**
   * Denormalised onto the hot item on purpose.
   *
   * The board needs the uplink chain to tell an engineer whether the device
   * they clicked is a cause or a symptom, and that answer has to be available
   * in the same read that fetched the device. Looking it up separately would
   * be one round trip per row, which is the N+1 this whole storage design
   * exists to avoid.
   */
  uplinkDeviceId?: DeviceId;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Alarms and incidents
// ---------------------------------------------------------------------------

/** What a deterministic rule decided about ONE entity. Not yet a page. */
export type AlarmKind =
  | 'link-down'
  | 'device-unreachable'
  | 'adjacency-lost'
  | 'interface-errors'
  | 'capacity-saturation'
  | 'optical-degradation'
  | 'power-fault';

export type Alarm = {
  tenantId: TenantId;
  alarmId: AlarmId;
  deviceId: DeviceId;
  interfaceId?: InterfaceId;
  siteId: SiteId;
  kind: AlarmKind;
  severity: Severity;
  /** The observations that triggered it - ideally from independent planes. */
  observationIds: ObservationId[];
  /** Which vantage points agreed. Two or more is the bar for an incident. */
  planes: ObservationPlane[];
  location: { lon: number; lat: number };
  /** The upstream device, when known. Drives the merge rule. */
  uplinkDeviceId?: DeviceId;
  raisedAt: string;
};

/**
 * A corroborated cluster of alarms. THIS is what humans get paged about.
 *
 * One distribution switch failure produces forty alarms and exactly one
 * incident.
 */
export type Incident = {
  tenantId: TenantId;
  incidentId: IncidentId;
  title: string;
  severity: Severity;
  status: 'open' | 'acknowledged' | 'resolved';
  siteId: SiteId;
  deviceIds: DeviceId[];
  alarmIds: AlarmId[];
  /** The device correlation believes is the cause, not merely a symptom. */
  rootCauseDeviceId?: DeviceId;
  openedAt: string;
  /** Written by the Bedrock agent, not by a human. */
  aiSummary?: string;
  aiCitations?: Array<{ source: string; snippet: string }>;
};

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * How much of the estate a caller may see.
 *
 * A discriminated union rather than an optional `siteId`, precisely so that a
 * repository function cannot accidentally treat "no site" as "all sites".
 * Widening access has to be a deliberate `kind: 'tenant'`.
 */
export type Scope =
  | { kind: 'tenant' }                        // whole estate - admins
  | { kind: 'region'; region: string }        // a regional NOC
  | { kind: 'site'; siteId: SiteId }          // one site's operator
  | { kind: 'device'; deviceId: DeviceId };   // a single box - a field engineer

/** The identity the rest of the code trusts, produced by verifying a JWT. */
export type Principal = {
  sub: string;
  email: string;
  tenantId: TenantId;
  /** Roles come from Cognito groups, mapped from SAML/OIDC claims upstream. */
  roles: Array<'admin' | 'operator' | 'engineer' | 'viewer'>;
  /** How much of the estate this caller may see. Never a bare site id. */
  scope: Scope;
  /** Which IdP the user actually came from - useful for audit + debugging. */
  identityProvider: 'cognito' | 'Google' | 'Facebook' | 'SignInWithApple' | 'AcmeSAML' | 'OktaOIDC';
};
