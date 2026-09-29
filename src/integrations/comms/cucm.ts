/**
 * ---------------------------------------------------------------------------
 * CUCM RisPort70: are the desk phones actually registered?
 * ---------------------------------------------------------------------------
 * Kurmi says which Cisco desk phones EXIST and where they belong. It cannot
 * say whether they WORK: that is the call control's knowledge - Cisco Unified
 * CM, whether on premises or hosted by Cisco as Webex Calling Dedicated
 * Instance (DI is a CUCM cluster; the API is the same). A phone that cannot
 * register makes no calls, so Teams and Webex, which judge calls, see nothing
 * at all - the same SILENCE as a dead SBC's. This is the only witness.
 *
 * Shape from Cisco's PUBLISHED RisPort70 reference (DevNet, "RisPort70 API"),
 * not from a live cluster; the mock follows it. What is unverified is marked.
 *
 * WHAT IS EASY TO GET WRONG, all from that reference:
 *
 *   selectCmDeviceExt, NOT selectCmDevice. The plain one returns a row per
 *   NODE a phone ever registered on - a phone that failed over is both
 *   Registered and UnRegistered in one answer. Ext collates to the latest
 *   registration. It also takes NO WILDCARDS: phones are asked for by name,
 *   and the names come from Kurmi. No Kurmi this poll, no question to ask.
 *
 *   TRUNCATION IS SILENT. One answer carries at most 2000 devices, and "the
 *   response does not indicate if results greater than 2000 have been
 *   truncated". Asking by explicit name in batches of RIS_BATCH makes it
 *   impossible by construction, and an answer AT the ceiling is refused.
 *   `TotalDevicesFound` is NOT used to check: how Ext counts a phone that
 *   registered on two nodes is not documented, and a guard built on a guess
 *   would fail good reads for every phone that ever failed over.
 *
 *   THE RATE LIMIT IS THE CLUSTER'S, SHARED. RisPort70 accepts ~15 requests a
 *   minute (an enterprise parameter, 18 at most) ACROSS EVERY APPLICATION
 *   using it - the customer's own tools included. We take the tenant's
 *   configured share, pace to it, and stop at a per-poll budget. A building
 *   whose phones were not all asked gets NO signal - "not measured", never a
 *   partial rate that looks like health.
 *
 *   A NODE THAT DID NOT ANSWER FAILS THE READ. A phone registered to a node
 *   that is `NodeNotResponding` can look UnRegistered on another; counting
 *   those would page for the cluster, not the building. Could-not-ask is not
 *   saw-nothing: the source is down this poll, named with the node.
 *
 *   CASE IS NOT STABLE. The reference spells a node's return code `Ok` in
 *   one place and `OK` in another, and the status enum `UnRegistered`. Every
 *   comparison is case-insensitive.
 *
 *   THE ANSWER CARRIES PEOPLE. `LoginUserId` (Extension Mobility), a
 *   `Description` that is usually someone's name, and the extension. None of
 *   it is read: a device's name, status, reason and timestamp are all this
 *   needs, and a field never parsed can never be stored.
 *
 * WHICH UNREGISTRATIONS COUNT. StatusReason says why. ConnectivityError (6)
 * and KeepAliveTimeout (13) mean the network between the phone and the call
 * control failed - the thing this signal is about. A phone switched off, wiped,
 * reset by an administrator or logged out of is a DECISION - the comms
 * version of an admin-down port - and is left out of the rate. So is a phone
 * that has been unregistered for DORMANT_AFTER_MS: a desk nobody sits at is a
 * data-quality item, not an outage, and would otherwise hold a building's
 * rate up forever. (A whole building down past that age has no measured
 * phones left, which is "not measured" - the incident stays open.)
 */
import type { Severity } from '../../platform/types.ts';
import { childText, childrenNamed, child, descendants, escapeXml, parseXml, type XmlElement } from '../../platform/xml.ts';
import { CommsHttpError, type CommsClient } from './client.ts';

/** Names per request. The reference suggests ~500; well under the 2000 ceiling. */
export const RIS_BATCH = 500;
/** The ceiling on one answer, per the reference. */
export const RIS_MAX_RETURNED = 2000;
/** Requests one poll may make, whatever the share: 10,000 phones at RIS_BATCH. */
export const MAX_RIS_REQUESTS_PER_POLL = 20;
/** Unregistered longer than this is a dormant desk, not an outage. */
export const DORMANT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The network failed between the phone and the call control. */
export const NETWORK_REASONS: Readonly<Record<number, string>> = { 6: 'ConnectivityError', 13: 'KeepAliveTimeout' };

/**
 * Switched off, reset or logged out - by someone, or by its own battery. Not
 * the network, and not a phone that is trying to work: left out of the rate,
 * like an admin-down port. From the reference's StatusReason table.
 */
export const DECIDED_REASONS: ReadonlySet<number> = new Set([
  9,    // CallManagerReset - reset from CUCM Administration
  17,   // CallManagerApplyConfig
  19,   // EMLoginLogout
  20,   // EMCCLoginLogout
  30,   // DeviceWipe - factory reset by an administrator
  33,   // LowBattery - off, though nobody chose it
  34,   // ManualPowerOff
]);

/** A phone Kurmi placed in a building, by the name CUCM knows it by. */
export type DeskPhone = { name: string; facility: string };

export type RisStatus = 'registered' | 'unregistered' | 'rejected' | 'partial' | 'unknown';

/** What RisPort70 said about one phone. Nothing about who uses it. */
export type RisDevice = { name: string; status: RisStatus; reason: number; changedAt?: number };

/** The selectCmDeviceExt envelope. Every name escaped; auth is a Basic header, not in the body. */
export function selectEnvelope(names: string[]): string {
  return '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap="http://schemas.cisco.com/ast/soap">' +
    '<soapenv:Header/><soapenv:Body><soap:selectCmDeviceExt>' +
    '<soap:StateInfo></soap:StateInfo>' +
    '<soap:CmSelectionCriteria>' +
    '<soap:MaxReturnedDevices>' + RIS_MAX_RETURNED + '</soap:MaxReturnedDevices>' +
    '<soap:DeviceClass>Phone</soap:DeviceClass>' +
    '<soap:Model>255</soap:Model>' +                        // 255 = any model
    '<soap:Status>Any</soap:Status>' +
    '<soap:NodeName></soap:NodeName>' +                     // empty = every node
    '<soap:SelectBy>Name</soap:SelectBy>' +
    '<soap:SelectItems>' + names.map((n) => '<soap:item><soap:Item>' + escapeXml(n) + '</soap:Item></soap:item>').join('') +
    '</soap:SelectItems>' +
    '<soap:Protocol>Any</soap:Protocol>' +
    '<soap:DownloadStatus>Any</soap:DownloadStatus>' +
    '</soap:CmSelectionCriteria>' +
    '</soap:selectCmDeviceExt></soapenv:Body></soapenv:Envelope>';
}

const lower = (s: string | undefined) => (s ?? '').trim().toLowerCase();

function statusOf(text: string | undefined): RisStatus {
  switch (lower(text)) {
    case 'registered': return 'registered';
    case 'unregistered': return 'unregistered';
    case 'rejected': return 'rejected';
    case 'partiallyregistered': return 'partial';
    default: return 'unknown';
  }
}

/**
 * Parse one answer. Throws on a SOAP Fault, on any node that did not answer,
 * on an answer at the ceiling, and on more distinct phones than were asked
 * about. The same phone twice is tolerated - the caller keeps the latest.
 * Reads name, status, reason and time - nothing else.
 */
export function parseSelect(xml: string, asked: number): RisDevice[] {
  const doc = parseXml(xml);
  const fault = descendants(doc, 'Fault')[0];
  if (fault) throw new CommsHttpError('cucm', 500, 'SOAP Fault: ' + (childText(fault, 'faultstring') ?? 'unknown'));

  const nodes = descendants(doc, 'CmNodes')[0];
  if (!nodes) throw new CommsHttpError('cucm', 200, 'no CmNodes in the response');
  const devices: RisDevice[] = [];
  for (const node of childrenNamed(nodes, 'item')) {
    const code = lower(childText(node, 'ReturnCode'));
    // NotFound is an answer (none of the asked phones is on that node); every
    // other code means we do not know what that node would have said.
    if (code !== 'ok' && code !== 'notfound') {
      throw new CommsHttpError('cucm', 200, 'node ' + (childText(node, 'Name') ?? '?') + ' answered ' + (childText(node, 'ReturnCode') ?? '(none)'));
    }
    const list = child(node, 'CmDevices');
    for (const d of list ? childrenNamed(list, 'item') : []) devices.push(deviceOf(d));
  }

  if (devices.length >= RIS_MAX_RETURNED) {
    // Cannot happen at RIS_BATCH; if it does, the answer may have stopped
    // short and would not say so.
    throw new CommsHttpError('cucm', 200, 'an answer at the ' + RIS_MAX_RETURNED + '-device ceiling may be truncated - RisPort70 does not say');
  }
  const distinct = new Set(devices.map((d) => d.name)).size;
  if (distinct > asked) {
    throw new CommsHttpError('cucm', 200, 'asked about ' + asked + ' phones and got ' + distinct);
  }
  return devices;
}

function deviceOf(d: XmlElement): RisDevice {
  const ts = Number(childText(d, 'TimeStamp'));
  return {
    name: (childText(d, 'Name') ?? '').toUpperCase(),
    status: statusOf(childText(d, 'Status')),
    reason: Number(childText(d, 'StatusReason') ?? 0) || 0,
    // Epoch SECONDS, UTC, per the reference.
    changedAt: Number.isFinite(ts) && ts > 0 ? ts * 1000 : undefined,
  };
}

export type RegistrationRead = {
  /** By upper-cased device name. A phone absent here has NO record in RIS. */
  devices: Map<string, RisDevice>;
  requests: number;
  /** Phones not asked because the per-poll budget ran out. */
  notAsked: DeskPhone[];
};

/**
 * Ask RisPort70 about these phones: batched, paced to the tenant's share of
 * the cluster's allowance, and stopped at the per-poll budget. Batches are
 * cut in facility order, so the budget running out leaves WHOLE buildings
 * unmeasured rather than every building partly measured.
 */
export async function readRegistrations(
  client: CommsClient, phones: DeskPhone[], requestsPerMinute: number,
): Promise<RegistrationRead> {
  const ordered = [...phones].sort((a, b) => a.facility.localeCompare(b.facility) || a.name.localeCompare(b.name));
  const devices = new Map<string, RisDevice>();
  const gapMs = Math.ceil(60_000 / Math.max(1, requestsPerMinute));
  let requests = 0;
  let i = 0;
  for (; i < ordered.length && requests < MAX_RIS_REQUESTS_PER_POLL; i += RIS_BATCH) {
    if (requests > 0) await client.sleep(gapMs);
    const batch = ordered.slice(i, i + RIS_BATCH).map((p) => p.name);
    const res = await client.request('cucm', client.endpoints.cucmRis, {
      method: 'POST',
      // SOAPAction as the WSDL names the operation - not in the reference's
      // text, so verify it against a real cluster.
      headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml', SOAPAction: '"selectCmDeviceExt"' },
      body: selectEnvelope(batch),
    });
    requests++;
    for (const d of parseSelect(await res.text(), batch.length)) {
      const prev = devices.get(d.name);
      // Ext collates across nodes already; if a name comes back twice anyway, the latest wins.
      if (!prev || (d.changedAt ?? 0) >= (prev.changedAt ?? 0)) devices.set(d.name, d);
    }
  }
  return { devices, requests, notAsked: ordered.slice(i) };
}

// ---------------------------------------------------------------------------
// Phones -> one number per building
// ---------------------------------------------------------------------------

export type FacilityRegistration = {
  facility: string;
  /** Phones in the rate: answered, not decided off, not dormant. */
  measured: number;
  /** Of those, dropped by the network. */
  dropped: number;
  /** Dropped, by reason name - the evidence. */
  byReason: Record<string, number>;
  /** Switched off / reset / logged out on purpose. Not in the rate. */
  decided: number;
  /** Rejected or partially registered - configuration, not the network. */
  misconfigured: number;
};

export type RegistrationReport = {
  byFacility: FacilityRegistration[];
  /** Unregistered for longer than DORMANT_AFTER_MS. Data quality. */
  dormant: number;
  /** Kurmi has them; RIS has no record at all (never registered, or another cluster). */
  noRecord: number;
  /** Buildings with a phone the budget did not reach: NOT measured this poll. */
  unmeasuredFacilities: string[];
  requests: number;
};

/** Pure. Classify every phone against what RIS said, per building. */
export function summariseRegistrations(phones: DeskPhone[], read: RegistrationRead, at: number): RegistrationReport {
  const skipped = new Set(read.notAsked.map((p) => p.facility));
  const byFacility = new Map<string, FacilityRegistration>();
  let dormant = 0;
  let noRecord = 0;
  for (const p of phones) {
    if (skipped.has(p.facility)) continue;
    const f = byFacility.get(p.facility) ??
      { facility: p.facility, measured: 0, dropped: 0, byReason: {}, decided: 0, misconfigured: 0 };
    byFacility.set(p.facility, f);
    const d = read.devices.get(p.name.toUpperCase());
    if (!d || d.status === 'unknown') { noRecord++; continue; }
    if (d.status === 'rejected' || d.status === 'partial') { f.misconfigured++; continue; }
    if (d.status === 'registered') { f.measured++; continue; }
    // Unregistered.
    if (DECIDED_REASONS.has(d.reason)) { f.decided++; continue; }
    if (d.changedAt !== undefined && at - d.changedAt > DORMANT_AFTER_MS) { dormant++; continue; }
    f.measured++;
    const why = NETWORK_REASONS[d.reason];
    if (why) {
      f.dropped++;
      f.byReason[why] = (f.byReason[why] ?? 0) + 1;
    }
    // Any other reason (a reset the phone started, a fallback, "Unknown") is
    // unregistered but not the network's doing: measured, not dropped.
  }
  return {
    byFacility: [...byFacility.values()].sort((a, b) => a.facility.localeCompare(b.facility)),
    dormant, noRecord, unmeasuredFacilities: [...skipped].sort(), requests: read.requests,
  };
}

/** Starting values, like every comms threshold - revisit against a month of real data. */
export const DESK_PHONE_THRESHOLDS = { warning: 0.2, critical: 0.5, minSamples: 5, minDropped: 3 } as const;

/**
 * A building's rate: ok, warning or critical. Below `minSamples` measured
 * phones there is no rate; below `minDropped` a high rate is still `ok` - one
 * phone of four unplugged is 25% and is not news.
 */
export function deskPhoneSeverity(f: FacilityRegistration): Severity | undefined {
  if (f.measured < DESK_PHONE_THRESHOLDS.minSamples) return undefined;
  const rate = f.dropped / f.measured;
  if (f.dropped < DESK_PHONE_THRESHOLDS.minDropped) return 'ok';
  if (rate >= DESK_PHONE_THRESHOLDS.critical) return 'critical';
  if (rate >= DESK_PHONE_THRESHOLDS.warning) return 'warning';
  return 'ok';
}

/** The detail sentence. Counts and reason names; never a phone, never a person. */
export function describeRegistration(f: FacilityRegistration, name: string): string {
  const reasons = Object.entries(f.byReason).sort(([a], [b]) => a.localeCompare(b)).map(([r, n]) => r + ' ' + n).join(', ');
  return f.dropped + ' of ' + f.measured + ' desk phones at ' + name + ' dropped off the call control' +
    (reasons ? ' - the network lost them (' + reasons + ')' : '') +
    '; a phone that cannot register makes no calls, so no call-quality source can see this';
}
