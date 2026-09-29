/**
 * ---------------------------------------------------------------------------
 * CUCM RisPort70 (Cisco Unified CM, or Webex Calling Dedicated Instance) - the mock
 * ---------------------------------------------------------------------------
 *   POST /realtimeservice2/services/RISService70   SOAP selectCmDeviceExt, Basic auth
 *
 * Modelled from Cisco's PUBLISHED RisPort70 reference (DevNet), not from a
 * live cluster. The host is a reserved `.example` name on the documented port.
 *
 * FROM THE REFERENCE:
 *   - selectCmDeviceExt by Name, with explicit items - Ext takes NO wildcards.
 *   - At most 2000 devices per answer, and truncation is NOT flagged.
 *   - Per device: Name, Status, StatusReason, TimeStamp (epoch seconds) - and
 *     LoginUserId, Description and DirNumber, which carry PEOPLE. They are
 *     here on purpose: the connector's not reading them is tested against an
 *     answer that has them.
 *   - Per node: ReturnCode, spelled `Ok` in the reference's own example.
 *   - Status enum spelled `UnRegistered`.
 *   - A rate limit of 15 requests a minute across the cluster (the default).
 *
 * ASSUMED (verify against a real cluster):
 *   - The Fault wordings. The rate one is as commonly reported, typo included.
 *   - A name the cluster has no record of is simply absent from the answer.
 *
 * The phones are KURMI'S (kurmiPhones), so the two mocks describe one estate.
 *
 * THE PLANT: most of El Paso's desk phones (F-ELP2031) have dropped off -
 * KeepAliveTimeout and ConnectivityError - inside the planted window. Teams
 * and Webex see nothing, because the phones make no calls. Around it, the
 * traps: two phones switched off on purpose, a desk dormant for a month, a
 * rejected phone, two that never registered, a phone mid-reset, and ONE
 * Houston phone dropped - too few to be news.
 */
import { now } from '../../../platform/clock.ts';
import { seededRandom } from '../../../platform/random.ts';
import { childText, childrenNamed, descendants, escapeXml, parseXml, XmlError } from '../../../platform/xml.ts';
import { createApp, type MockApp, type MockResponse } from './kernel.ts';
import { kurmiPhones, type KurmiPhone } from './kurmi.ts';
import { activityAnchor, plantedActive, PLANTED_WINDOW_MS } from './time.ts';

export const CUCM_NODES = ['cucm-sub1', 'cucm-sub2'] as const;
export const PLANTED_DESK_PHONES = { facilityDepartment: 'F-ELP2031', facility: '2031' } as const;

/** The cluster's default allowance. Requests within the last minute, by the injected clock. */
let ratePerMinute = 15;
let recent: number[] = [];
let nodeDown: string | undefined;

export function setCucmRateLimit(n: number): void { ratePerMinute = n; }
/** Make one node answer NodeNotResponding - the cluster's problem, not a building's. */
export function setCucmNodeDown(node: string | undefined): void { nodeDown = node; }
export function resetCucm(): void { ratePerMinute = 15; recent = []; nodeDown = undefined; }

type RisRow = { status: 'Registered' | 'UnRegistered' | 'Rejected'; reason: number; changedAt: number };

/** What the cluster knows about each phone right now. Undefined: no record at all. */
function risState(): Map<string, RisRow> {
  const anchor = activityAnchor();
  // Its own seed, like kurmi.ts - never the ambient random stream.
  const rng = seededRandom(0x4355434d);   // 'CUCM'
  const phones = kurmiPhones();
  const out = new Map<string, RisRow>();
  const elPaso = (p: KurmiPhone) => p.department.includes(PLANTED_DESK_PHONES.facilityDepartment);
  const others = phones.filter((p) => !elPaso(p) && !p.disabled);
  const houston = others.find((p, i) => i > 7 && p.department.includes('F-HOU1120'));
  const day = 24 * 60 * 60 * 1000;

  for (const p of phones) {
    const settled = anchor - Math.floor(rng() * 3 * day);          // registered some time in the last three days
    const dropped = anchor - PLANTED_WINDOW_MS + 10 * 60 * 1000 + Math.floor(rng() * 20 * 60 * 1000);
    let row: RisRow = { status: 'Registered', reason: 0, changedAt: settled };
    if (elPaso(p) && plantedActive() && rng() < 0.75) {
      // Mostly keepalives lost; some connections refused outright.
      row = { status: 'UnRegistered', reason: out.size % 4 === 0 ? 6 : 13, changedAt: dropped };
    }
    out.set(p.ciscoName, row);
  }
  // The traps, by position among the non-El Paso phones.
  const set = (p: KurmiPhone | undefined, row: RisRow | undefined) => {
    if (!p) return;
    if (row) out.set(p.ciscoName, row); else out.delete(p.ciscoName);
  };
  set(others[0], { status: 'UnRegistered', reason: 34, changedAt: anchor - 2 * 60 * 60 * 1000 });   // ManualPowerOff
  set(others[1], { status: 'UnRegistered', reason: 34, changedAt: anchor - 20 * 60 * 1000 });       // ManualPowerOff
  set(others[2], { status: 'UnRegistered', reason: 13, changedAt: anchor - 30 * day });             // dormant desk
  set(others[3], { status: 'Rejected', reason: 14, changedAt: anchor - 3 * 60 * 60 * 1000 });       // ConfigurationMismatch
  set(others[4], undefined);                                                                        // never registered
  set(others[5], undefined);
  set(others[6], { status: 'UnRegistered', reason: 8, changedAt: anchor - 2 * 60 * 1000 });         // DeviceInitiatedReset
  set(houston, { status: 'UnRegistered', reason: 13, changedAt: anchor - 12 * 60 * 1000 });         // one Houston phone
  return out;
}

// ---------------------------------------------------------------------------
// SOAP
// ---------------------------------------------------------------------------

const envelope = (body: string) =>
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' + body + '</soapenv:Body></soapenv:Envelope>';

const xml = (status: number, body: string): MockResponse =>
  ({ status, contentType: 'text/xml; charset=utf-8', body: '<?xml version="1.0" encoding="UTF-8"?>' + envelope(body) });

function fault(message: string): MockResponse {
  return xml(500, '<soapenv:Fault><faultcode>soapenv:Server.userException</faultcode><faultstring>' +
    escapeXml(message) + '</faultstring></soapenv:Fault>');
}

const el = (name: string, value: string | number) => '<ns1:' + name + '>' + escapeXml(String(value)) + '</ns1:' + name + '>';

function select(bodyText: string): MockResponse {
  const at = now();
  recent = recent.filter((t) => at - t < 60_000);
  if (recent.length >= ratePerMinute) {
    return fault('AxisFault: Exceeded allowed rate for Reatime information. Current allowed rate for realtime information is ' +
      ratePerMinute + ' requests per minute.');
  }
  recent.push(at);

  let doc;
  try { doc = parseXml(bodyText); } catch (err) {
    return fault('Unmarshalling error: ' + (err instanceof XmlError ? err.message : 'malformed request'));
  }
  const op = descendants(doc, 'selectCmDeviceExt')[0];
  if (!op) return fault('Only selectCmDeviceExt is modelled by the mock');
  const criteria = descendants(op, 'CmSelectionCriteria')[0];
  if (!criteria || childText(criteria, 'SelectBy') !== 'Name') return fault('Only SelectBy Name is modelled by the mock');
  const items = descendants(criteria, 'Item').map((i) => i.text.trim());
  if (items.some((i) => i.includes('*'))) return fault('Wildcard is not supported for selectCmDeviceExt');
  const max = Math.min(2000, Number(childText(criteria, 'MaxReturnedDevices') ?? 2000) || 2000);

  const state = risState();
  const found = [...new Set(items.map((i) => i.toUpperCase()))].filter((n) => state.has(n));
  // Truncated SILENTLY: the count says what was returned, not what was found.
  const returned = found.slice(0, max);
  const byNode = new Map<string, string[]>(CUCM_NODES.map((n) => [n, []]));
  returned.forEach((name, i) => byNode.get(CUCM_NODES[i % CUCM_NODES.length])!.push(name));

  const nodes = CUCM_NODES.map((node, n) => {
    if (node === nodeDown) {
      return '<ns1:item>' + el('ReturnCode', 'NodeNotResponding') + el('Name', node) + el('NoChange', 'false') + '<ns1:CmDevices/></ns1:item>';
    }
    const devices = byNode.get(node)!.map((name) => {
      const r = state.get(name)!;
      const ext = String(4400 + (parseInt(name.slice(-3), 16) % 500));
      return '<ns1:item>' + el('Name', name) +
        el('DirNumber', ext + '-' + r.status) + el('DeviceClass', 'Phone') + el('Model', 36670) + el('Product', 36670) +
        el('BoxProduct', 0) + el('Httpd', 'Yes') + el('RegistrationAttempts', 0) + el('IsCtiControllable', 'true') +
        // PEOPLE. Present on purpose; see the header.
        el('LoginUserId', 'em.user' + ext) + el('Status', r.status) + el('StatusReason', r.reason) + el('PerfMonObject', 2) +
        el('DChannel', 0) + el('Description', 'Desk phone - Pat Example x' + ext) + '<ns1:H323Trunk/>' +
        el('TimeStamp', Math.floor(r.changedAt / 1000)) + el('Protocol', 'SIP') + el('NumOfLines', 1) +
        el('ActiveLoadID', 'sip8845_65.14-2-1-0001-14') + el('DownloadStatus', 'Successful') +
        '<ns1:IPAddress><ns1:item>' + el('IP', '10.20.' + (n + 1) + '.' + (parseInt(name.slice(-2), 16) % 250 + 2)) +
        el('IPAddrType', 'ipv4') + el('Attribute', 'AdministrativeAndSignaling') + '</ns1:item></ns1:IPAddress>' +
        '</ns1:item>';
    }).join('');
    // `Ok`, as the reference's example spells it - the connector must not care.
    return '<ns1:item>' + el('ReturnCode', n === 0 ? 'Ok' : 'OK') + el('Name', node) + el('NoChange', 'false') +
      '<ns1:CmDevices>' + devices + '</ns1:CmDevices></ns1:item>';
  }).join('');

  return xml(200, '<ns1:selectCmDeviceExtResponse xmlns:ns1="http://schemas.cisco.com/ast/soap"><ns1:selectCmDeviceReturn>' +
    '<ns1:SelectCmDeviceResult>' + el('TotalDevicesFound', returned.length) + '<ns1:CmNodes>' + nodes + '</ns1:CmNodes></ns1:SelectCmDeviceResult>' +
    el('StateInfo', '<StateInfo ClusterWide="1"><Node Name="' + CUCM_NODES[0] + '" SubsystemStartTime="1757300000" StateId="' +
      (1 + recent.length) + '" TotalItemsFound="' + returned.length + '" TotalItemsReturned="' + returned.length + '"/></StateInfo>') +
    '</ns1:selectCmDeviceReturn></ns1:selectCmDeviceExtResponse>');
}

export const cucmRis: MockApp = createApp('cucm', 'ris', [
  { method: 'POST', pattern: '/realtimeservice2/services/RISService70', handler: (req) => select(req.body) },
], (status, _code, message) => status === 401
  // Tomcat's page, not SOAP: authentication fails before the web service runs.
  ? { status, contentType: 'text/html', body: '<html><head><title>HTTP Status 401 - Unauthorized</title></head><body><h1>HTTP Status 401</h1></body></html>' }
  : fault(message));

/** The planted El Paso phones, for the tests: how many are in the plant, and how many were dropped. */
export function plantedDeskPhones(): { total: number; dropped: number } {
  const state = risState();
  const phones = kurmiPhones().filter((p) => !p.disabled && p.department.includes(PLANTED_DESK_PHONES.facilityDepartment));
  const dropped = phones.filter((p) => state.get(p.ciscoName)?.status === 'UnRegistered').length;
  return { total: phones.length, dropped };
}
