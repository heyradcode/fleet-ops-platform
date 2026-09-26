/**
 * ---------------------------------------------------------------------------
 * Kurmi: the Cisco phone estate, split by agency and facility
 * ---------------------------------------------------------------------------
 * The discovery notes' third split: Cisco desk phones provisioned through
 * Kurmi, agency in `param2`, facility in `kurmiDepartment`. These are DEVICES,
 * not people - they have no email to join on - so they are an inventory of
 * their own, not columns in the workforce.
 *
 * SOAP, AND THREE THINGS THAT GO WITH IT:
 *
 *   HTTP 200 IS NOT SUCCESS. The body's `<status>` is the answer; a 200 with
 *   `FAILURE` inside is a failure. A SOAP Fault is a failure too.
 *
 *   CREDENTIALS ARE IN THE BODY. `client.soap()` hands them to the envelope
 *   builder so this file never holds them, and every value - credentials
 *   included - is XML-escaped: a password with a `<` in it would otherwise
 *   break the envelope, or rewrite it.
 *
 *   PAGING IS UNKNOWN. The response says `listIsNotComplete` but the one
 *   sample does not show how to ask for the rest, and a guessed parameter
 *   that the server ignores returns the SAME first page forever. So this does
 *   not page: it PARTITIONS. Every Cisco phone is `SEP` + a MAC in hex, so a
 *   truncated search is re-asked as sixteen narrower ones (`SEP0`..`SEPF`),
 *   and those again if needed. A slice still truncated at the depth limit
 *   marks the inventory INCOMPLETE - the shorter-estate failure, made loud.
 *
 * FACILITY FROM THE PATH'S LEAF. `kurmiDepartment` is `/Org/Region/Facility`
 * (from the sample's shape); the leaf is looked up in a tenant table, as
 * Webex locations and Helix sites are. Paths are normalised - trimmed,
 * trailing slash dropped, compared case-insensitively. The org/region/facility
 * depth is an ASSUMPTION from one sample; the notes say to confirm it on a
 * true result.
 */
import { childText, childrenNamed, descendants, escapeXml, parseXml, type XmlElement } from '../../platform/xml.ts';
import { CommsHttpError, type CommsClient } from './client.ts';
import type { CommsTenantConfig } from './types.ts';

/** How many times a truncated slice may be split. 2 -> up to 256 searches. */
export const MAX_PARTITION_DEPTH = 2;
const HEX = '0123456789ABCDEF';

export type PhoneAgency =
  | { kind: 'agency'; agency: string }
  | { kind: 'unknown-code'; code: string }
  | { kind: 'blank' };

export type PhoneUnplaced = 'no-department' | 'no-facility-leaf' | 'unmapped-department';

export type Phone = {
  dbid: string;
  agency: PhoneAgency;
  facility?: string;
  unplaced?: PhoneUnplaced;
  /** The leaf that failed to map, for the data-quality list. */
  departmentLeaf?: string;
  disabled: boolean;
  model: string;
};

export type PhoneInventory = {
  asOf: string;
  /** Searches issued - more than one means the estate needed partitioning. */
  searches: number;
  /** Some slice was still truncated at the depth limit: counts are LOW. */
  truncated: boolean;
  /** Enabled phones. Disabled ones are counted separately, not in the split. */
  total: number;
  disabled: number;
  byAgency: Record<string, number>;
  unknownAgencyCodes: Record<string, number>;
  blankAgency: number;
  byFacility: Array<{ code: string; count: number }>;
  unplaced: Partial<Record<PhoneUnplaced, number>>;
  unmappedDepartments: string[];
};

/** The SEARCH_QUERY_TYPE envelope, every value escaped. Shape from the sample. */
export function searchEnvelope(auth: { login: string; password: string }, tenantDbid: string, prefix: string): string {
  return '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="http://www.nates.fr/API/1.0">' +
    '<soapenv:Header/><soapenv:Body><ns:SEARCH_QUERY_TYPE>' +
    '<auth><login>' + escapeXml(auth.login) + '</login><password>' + escapeXml(auth.password) + '</password>' +
    '<substitutionTenantOrTemplate type="TENANT" dbid="' + escapeXml(tenantDbid) + '"/></auth>' +
    '<filter type="device"><field name="ciscoName" criteria="StartsWith">' + escapeXml(prefix) + '</field></filter>' +
    '<detail>true</detail>' +
    '</ns:SEARCH_QUERY_TYPE></soapenv:Body></soapenv:Envelope>';
}

/** Parse a search response. Throws on a Fault or a non-SUCCESS status, whatever the HTTP code said. */
export function parseSearch(xml: string): { devices: XmlElement[]; complete: boolean } {
  const doc = parseXml(xml);
  const fault = descendants(doc, 'Fault')[0];
  if (fault) throw new CommsHttpError('kurmi', 500, 'SOAP Fault: ' + (childText(fault, 'faultstring') ?? 'unknown'));
  const result = descendants(doc, 'SEARCH_RESULT_TYPE')[0];
  if (!result) throw new CommsHttpError('kurmi', 200, 'no SEARCH_RESULT_TYPE in the response');
  const status = childText(result, 'status');
  if (status !== 'SUCCESS') {
    // 200 is not success. Not retryable: a bad login does not improve.
    throw new CommsHttpError('kurmi', 200, 'status ' + (status ?? '(none)') + ': ' + (childText(result, 'errorMessage') ?? ''));
  }
  const total = childrenNamed(result, 'totalNumberOfResults')[0];
  return {
    devices: childrenNamed(result, 'componentDetail'),
    // Either flag saying "there is more" counts. Believe the pessimist.
    complete: total?.attrs.listIsNotComplete !== 'true' && total?.attrs.endOfListReached !== 'false',
  };
}

/** Every device, partitioning by ciscoName prefix whenever a search comes back truncated. */
export async function pullKurmiDevices(
  client: CommsClient, tenantDbid: string,
): Promise<{ devices: XmlElement[]; searches: number; truncated: boolean }> {
  const seen = new Map<string, XmlElement>();
  let searches = 0;
  let truncated = false;
  const queue: Array<{ prefix: string; depth: number }> = [{ prefix: 'SEP', depth: 0 }];

  while (queue.length > 0) {
    const { prefix, depth } = queue.shift()!;
    const res = await client.soap('kurmi', client.endpoints.kurmiApi, (auth) => searchEnvelope(auth, tenantDbid, prefix));
    searches++;
    const { devices, complete } = parseSearch(await res.text());
    if (!complete && depth < MAX_PARTITION_DEPTH) {
      // Discard this slice's partial rows; its sixteen children will return them all.
      for (const h of HEX) queue.push({ prefix: prefix + h, depth: depth + 1 });
      continue;
    }
    if (!complete) truncated = true;
    for (const d of devices) seen.set(d.attrs.dbid ?? '', d);
  }
  return { devices: [...seen.values()], searches, truncated };
}

function fieldOf(device: XmlElement, name: string): XmlElement | undefined {
  return descendants(device, 'field').find((f) => f.attrs.name === name);
}

/** Pure. One device -> a phone, classified. */
export function normalisePhone(device: XmlElement, config: NonNullable<CommsTenantConfig['kurmi']>): Phone {
  const text = (name: string) => fieldOf(device, name)?.text.trim() ?? '';

  const code = text('param2').toUpperCase();
  const known = config.agencyCodes.map((a) => a.toUpperCase());
  const agency: PhoneAgency = code === '' ? { kind: 'blank' }
    : known.includes(code) ? { kind: 'agency', agency: code }
      : { kind: 'unknown-code', code };

  // The TECHNICAL value decides: the display value is a label ("Yes") that
  // localises; the technical one is the boolean.
  const disabled = fieldOf(device, 'disabled')?.attrs.technicalValue === 'true';

  const path = text('kurmiDepartment').replace(/\/+$/, '');
  const segments = path.split('/').filter((s) => s.length > 0);
  const phone: Phone = { dbid: device.attrs.dbid ?? '', agency, disabled, model: text('model') };
  if (segments.length === 0) return { ...phone, unplaced: 'no-department' };
  const leaf = segments[segments.length - 1];
  const hit = Object.entries(config.departmentFacility).find(([k]) => k.toLowerCase() === leaf.toLowerCase());
  if (hit) return { ...phone, facility: hit[1] };
  return segments.length < 3
    ? { ...phone, unplaced: 'no-facility-leaf', departmentLeaf: path }
    : { ...phone, unplaced: 'unmapped-department', departmentLeaf: leaf };
}

/** Pure. Phones -> counts. Nothing device-identifying survives. */
export function summarisePhones(phones: Phone[], searches: number, truncated: boolean, asOf: string): PhoneInventory {
  const inv: PhoneInventory = {
    asOf, searches, truncated, total: 0, disabled: 0,
    byAgency: {}, unknownAgencyCodes: {}, blankAgency: 0, byFacility: [], unplaced: {}, unmappedDepartments: [],
  };
  const facilities = new Map<string, number>();
  const unmapped = new Set<string>();
  for (const p of phones) {
    if (p.disabled) { inv.disabled++; continue; }
    inv.total++;
    if (p.agency.kind === 'agency') inv.byAgency[p.agency.agency] = (inv.byAgency[p.agency.agency] ?? 0) + 1;
    else if (p.agency.kind === 'unknown-code') inv.unknownAgencyCodes[p.agency.code] = (inv.unknownAgencyCodes[p.agency.code] ?? 0) + 1;
    else inv.blankAgency++;
    if (p.facility) facilities.set(p.facility, (facilities.get(p.facility) ?? 0) + 1);
    else if (p.unplaced) {
      inv.unplaced[p.unplaced] = (inv.unplaced[p.unplaced] ?? 0) + 1;
      if (p.unplaced === 'unmapped-department' && p.departmentLeaf) unmapped.add(p.departmentLeaf);
    }
  }
  inv.byFacility = [...facilities].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count }));
  inv.unmappedDepartments = [...unmapped].sort();
  return inv;
}

export async function pullPhoneInventory(
  client: CommsClient, config: CommsTenantConfig, asOf: string,
): Promise<PhoneInventory> {
  const kurmi = config.kurmi!;
  const { devices, searches, truncated } = await pullKurmiDevices(client, kurmi.tenantDbid);
  return summarisePhones(devices.map((d) => normalisePhone(d, kurmi)), searches, truncated, asOf);
}
