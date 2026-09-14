/**
 * ---------------------------------------------------------------------------
 * The wire contract: decoders and mappers
 * ---------------------------------------------------------------------------
 * The fleet build had ONE interface per vendor, with `fetchRaw` and
 * `normalise` on the same object. That worked because every telematics vendor
 * was pull-shaped: you called a REST API on a schedule and got JSON back.
 *
 * Network gear is not. Most of it pushes - syslog and SNMP traps over UDP,
 * IPFIX over UDP, gNMI dial-out over gRPC - and only the cloud controllers
 * (Meraki, Mist, Aruba Central) offer something pollable. So the thing that
 * RECEIVES bytes is no longer the thing that UNDERSTANDS them, and pretending
 * otherwise is what forces a listener into a Lambda that cannot hold a socket.
 *
 * The split, and the arithmetic that justifies it:
 *
 *   Decoder   keyed by ENCODING            bytes -> structured, still vendor-native
 *   Mapper    keyed by (vendor, platform, encoding)   structured -> Observation
 *
 * One file per vendor looks obvious and is a trap. "Cisco" is syslog AND SNMP
 * AND gNMI AND IPFIX AND two separate REST APIs; Juniper and Aruba send most of
 * those same formats. Per-vendor means writing the RFC 5424 parser three times
 * and maintaining three subtly different versions of it. Splitting on encoding
 * makes it N + M files instead of N x M, and - the part that actually matters -
 * it means a parser bug is fixed once.
 *
 * WHY DECODERS NEVER TOUCH BINARY. SNMP varbinds and IPFIX records arrive as
 * binary on the wire, and decoding them here would need `Buffer`, which this
 * codebase forbids because the whole graph is bundled into the browser. That
 * constraint pushes us to the right architecture anyway: the collector (Vector,
 * Fluent Bit, Telegraf) already does binary decode far better than we would,
 * and lands JSON in S3. Ours is the structural layer above that - splitting a
 * syslog line into fields, pairing OIDs with values - which is where the
 * vendor-specific ambiguity actually lives.
 */
import type {
  DeviceId, Encoding, InterfaceId, Observation, PlatformId, SiteId, TenantId, VendorId,
} from '../platform/types.ts';
import type { Inventory } from '../platform/inventory.ts';

/**
 * One S3 object, as the collector wrote it.
 *
 * BATCHED, not one object per datagram. A busy estate emits tens of thousands
 * of syslog lines a second; one S3 PUT and one Lambda invocation each would
 * cost more in requests than in everything else combined, and would bury the
 * account's concurrency limit. Firehose buffering (say 128MB or 60s) is what
 * makes the S3-triggered design affordable at all.
 *
 * The key it was written under carries the same facts - the layout is
 * `raw/tenant=.../vendor=.../encoding=.../dt=.../hh=...` - so the normaliser
 * can pick a decoder from the key without opening the object.
 */
export type RawBatch = {
  tenantId: TenantId;
  encoding: Encoding;
  /** When the COLLECTOR received these. Trusted, unlike anything in the payload. */
  receivedAt: string;
  source: {
    /** Which collector instance. For chasing a decode bug back to one host. */
    collector: string;
    /** The device's source address, where the transport gives us one. */
    address?: string;
  };
  /**
   * One entry per line, datagram or row. Deliberately `unknown` - nobody may
   * read it except that encoding's own decoder.
   */
  records: unknown[];
};

/**
 * A record after structural parsing, before anyone has decided what it means.
 *
 * Still vendor-native: `tag` is a Cisco mnemonic or a Junos event name or a
 * trap OID, and `fields` holds whatever the encoding defined. The point of this
 * intermediate shape is that it is the widest thing a decoder can produce
 * without knowing the vendor, and therefore the narrowest thing a mapper needs.
 */
export type DecodedRecord = {
  encoding: Encoding;
  receivedAt: string;
  /**
   * The device identity as CLAIMED by the wire - a hostname, a sysName, an IP.
   * Unresolved on purpose; resolving it needs the inventory, which decoders do
   * not have and should not.
   */
  claimedHost: string;
  /** The device's own timestamp, when it sent one. Untrusted. */
  claimedTime?: string;
  /** What identifies the message: `%LINK-3-UPDOWN`, `SNMP_TRAP_LINK_DOWN`, an OID. */
  tag: string;
  /** Structural fields the encoding defines. */
  fields: Record<string, string | number | boolean>;
  /** The original line or JSON, kept for debugging and for replay. */
  raw: string;
};

export type Decoder = {
  encoding: Encoding;
  /**
   * Structural parse only. MUST NOT throw on a malformed record: push feeds
   * carry truncated datagrams as a matter of routine, and one bad line must not
   * cost the other 40,000 in the batch. Skip it and carry on.
   */
  decode(batch: RawBatch): DecodedRecord[];
};

/**
 * What a mapper is given besides the record.
 *
 * Identity resolution is handed in rather than imported so that mappers stay
 * pure functions of their inputs - which is what makes replaying a fixed mapper
 * over the S3 archive produce exactly the same output it would have produced
 * live.
 */
export type MapContext = {
  tenantId: TenantId;
  inventory: Inventory;
  /** Resolved from `claimedHost` before the mapper is called. */
  deviceId: DeviceId;
  siteId?: SiteId;
  resolveInterface(opts: { name?: string; ifIndex?: number }): InterfaceId | undefined;
};

export type Mapper = {
  vendor: VendorId;
  platform: PlatformId;
  encoding: Encoding;
  /**
   * Does this record belong to me?
   *
   * Note what this does NOT have to decide: which vendor sent it. One syslog
   * listener serves a mixed estate - Cisco, Juniper and Aruba all arrive on the
   * same UDP port and land in the same prefix - but by the time a mapper is
   * consulted the host has been resolved against the inventory, and the
   * inventory knows what that device is. Sniffing the vendor from message text
   * would be guessing at something we already know for certain.
   *
   * What it decides is narrower and genuinely per-mapper: of this platform's
   * messages, is this one I handle? Returning false is the normal way an
   * unhandled message family is dropped - counted, not crashed on. Estates emit
   * an enormous volume of syslog that means nothing to a monitoring platform,
   * and silence about it is the correct behaviour.
   */
  claims(rec: DecodedRecord): boolean;
  /**
   * The ONLY place that understands this vendor.
   *
   * Pure. No clock, no network, no randomness - replay depends on it, and so
   * does the determinism invariant that lets two demo runs be diffed.
   */
  map(rec: DecodedRecord, ctx: MapContext): Observation[];
};
