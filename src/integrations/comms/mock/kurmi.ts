/**
 * ---------------------------------------------------------------------------
 * Kurmi (UC provisioning in front of Cisco CUCM) - the SOAP mock
 * ---------------------------------------------------------------------------
 *   POST /Kurmi/services/API     text/xml SOAP envelope, SEARCH_QUERY_TYPE
 *
 * Modelled from the ONE sample request/response in the discovery notes - its
 * structure, not its contents - because no schema has been obtained yet.
 * Everything not visible in that sample is an assumption, marked below; the
 * endpoint path is a placeholder, and the host a reserved `.example` name.
 *
 * FROM THE SAMPLE (structure):
 *   - Request: `<auth><login/><password/><substitutionTenantOrTemplate
 *     type="TENANT" dbid="..."/></auth>`, a `<filter type="device">` of
 *     `<field name=".." criteria="StartsWith|Contains">value</field>`, and
 *     `<detail>true</detail>`. Credentials travel IN THE BODY.
 *   - Response: `<status>`, `<totalNumberOfResults listIsNotComplete=".."
 *     endOfListReached="..">`, and per device `<componentDetail dbid type>`
 *     with `<fields><field name=".." technicalValue="..">display</field>`.
 *   - Agency in `param2`, cost centre in `param1`, facility in
 *     `kurmiDepartment` - LOWER-CASE k, whatever the notes call it - as a
 *     path, `/Org/Region/Facility`.
 *
 * ASSUMED (verify against the real API):
 *   - A server-side cap on results, reported by `listIsNotComplete="true"`.
 *     The sample shows the flag but not how to page; the connector does not
 *     guess a paging parameter, it partitions by `ciscoName` prefix instead.
 *   - Bad credentials answer HTTP 200 with `<status>FAILURE</status>` - the
 *     classic SOAP trap - and a malformed request answers a SOAP Fault (500).
 *
 * WHAT THE DATA KEEPS: agency codes outside HHSC/DSHS/DFPS (the real sample's
 * were NEITHER, which is how this was noticed), a lower-cased one, blanks,
 * department paths with a trailing slash, a path with no facility leaf, a
 * facility leaf the tenant has not mapped, and disabled phones.
 */
import { seededRandom } from '../../../platform/random.ts';
import { childText, childrenNamed, descendants, escapeXml, parseXml, XmlError } from '../../../platform/xml.ts';
import { createApp, type MockApp, type MockResponse } from './kernel.ts';

export const KURMI_TENANT_DBID = '9944001';
export const DEMO_KURMI_USER = { login: 'netpulse-readonly', password: 'demo-only-not-a-real-password' } as const;

/** Server-side cap on one search's results - ASSUMED; see the header. */
let maxResults = 100;
export function setKurmiMaxResults(n: number): void { maxResults = n; }
export function resetKurmi(): void { maxResults = 100; }

export type KurmiPhone = {
  dbid: string;
  ciscoName: string;
  agency: string;
  costCentre: string;
  department: string;
  model: string;
  disabled: boolean;
};

const DEPARTMENTS = [
  '/HHS/R-Central/F-AUS0412', '/HHS/R-Central/F-AUS0417', '/HHS/R-Gulf/F-HOU1120',
  '/HHS/R-North/F-DAL1455', '/HHS/R-West/F-ELP2031', '/HHS/R-Panhandle/F-LBB3308',
];

let phones: KurmiPhone[] | undefined;

export function kurmiPhones(): KurmiPhone[] {
  if (phones) return phones;
  // Its own seed: never draws from the ambient random stream. See directory.ts.
  const rng = seededRandom(0x4b55524d);   // 'KURM'
  const hex = () => '0123456789ABCDEF'[Math.floor(rng() * 16)];
  const agencies = ['HHSC', 'DSHS', 'DFPS'];
  const out: KurmiPhone[] = [];
  for (let i = 0; i < 150; i++) {
    out.push({
      dbid: String(9230000 + i),
      ciscoName: 'SEP' + Array.from({ length: 12 }, hex).join(''),
      agency: agencies[Math.floor(rng() * agencies.length)],
      costCentre: 'CC-' + String(4400 + Math.floor(rng() * 40)),
      department: DEPARTMENTS[Math.floor(rng() * DEPARTMENTS.length)],
      model: rng() < 0.7 ? 'Cisco 8845' : 'Cisco 7841',
      disabled: rng() < 0.05,
    });
  }
  // The traps, placed by index so a generator change cannot lose them.
  out[3].agency = 'dshs';                          // lower-cased
  out[8].agency = '';                              // never set
  out[9].agency = '';
  out[14].agency = 'OIG';                          // a code nobody configured
  out[21].department = '/HHS/R-North/F-DAL1455/';  // trailing slash
  out[33].department = '/HHS/R-Gulf';              // no facility leaf
  out[40].department = '/HHS/R-Central/F-AUS0999'; // a new facility, unmapped
  phones = out;
  return out;
}

// ---------------------------------------------------------------------------
// SOAP
// ---------------------------------------------------------------------------

const envelope = (body: string) =>
  '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' + body + '</S:Body></S:Envelope>';

const xmlResponse = (status: number, body: string): MockResponse =>
  ({ status, contentType: 'text/xml; charset=utf-8', body: '<?xml version="1.0" encoding="UTF-8"?>' + envelope(body) });

function soapFault(message: string): MockResponse {
  return xmlResponse(500, '<S:Fault><faultcode>S:Client</faultcode><faultstring>' + escapeXml(message) + '</faultstring></S:Fault>');
}

function failure(message: string): MockResponse {
  // HTTP 200, and a failure. The trap is modelled deliberately.
  return xmlResponse(200, '<ns2:SEARCH_RESULT_TYPE xmlns:ns2="http://www.nates.fr/API/1.0"><status>FAILURE</status>' +
    '<errorMessage>' + escapeXml(message) + '</errorMessage></ns2:SEARCH_RESULT_TYPE>');
}

function field(name: string, value: string, technical?: string): string {
  const t = technical === undefined ? '' : ' technicalValue="' + escapeXml(technical) + '"';
  return value === '' ? '<field' + t + ' name="' + name + '"/>' : '<field' + t + ' name="' + name + '">' + escapeXml(value) + '</field>';
}

function search(bodyText: string): MockResponse {
  let doc;
  try { doc = parseXml(bodyText); } catch (err) {
    return soapFault('Unmarshalling Error: ' + (err instanceof XmlError ? err.message : 'malformed request'));
  }
  const query = descendants(doc, 'SEARCH_QUERY_TYPE')[0];
  if (!query) return soapFault('Cannot find dispatch method for the request');

  const auth = childrenNamed(query, 'auth')[0];
  if (!auth || childText(auth, 'login') !== DEMO_KURMI_USER.login || childText(auth, 'password') !== DEMO_KURMI_USER.password) {
    return failure('Authentication failed: invalid login or password');
  }
  const tenant = childrenNamed(auth, 'substitutionTenantOrTemplate')[0];
  if (tenant?.attrs.dbid !== KURMI_TENANT_DBID) return failure('Unknown tenant ' + (tenant?.attrs.dbid ?? '(none)'));

  const filter = childrenNamed(query, 'filter')[0];
  if (filter?.attrs.type !== 'device') return failure('Only device searches are modelled by the mock');
  let rows = kurmiPhones();
  for (const f of childrenNamed(filter, 'field')) {
    const value = f.text.trim();
    const get = (p: KurmiPhone) => f.attrs.name === 'ciscoName' ? p.ciscoName : undefined;
    if (get(rows[0]) === undefined) return failure('Filter field not modelled: ' + f.attrs.name);
    rows = rows.filter((p) => {
      const v = get(p)!;
      return f.attrs.criteria === 'StartsWith' ? v.startsWith(value)
        : f.attrs.criteria === 'Contains' ? v.includes(value)
          : v === value;
    });
  }

  const complete = rows.length <= maxResults;
  const page = rows.slice(0, maxResults);
  const detail = childText(query, 'detail') === 'true';
  const devices = page.map((p) => '<componentDetail dbid="' + p.dbid + '" type="device"><fields>' +
    field('param1', p.costCentre) + field('param2', p.agency) + field('ciscoName', p.ciscoName) +
    (detail
      ? field('deviceKind', 'phone') + field('model', p.model) + field('kurmiDepartment', p.department) +
        field('disabled', p.disabled ? 'Yes' : 'No', String(p.disabled)) +
        // A taste of the other hundred-odd fields a detailed result carries.
        field('status', '') + field('ipAddress', '') + field('protocol', 'SIP')
      : '') +
    '</fields></componentDetail>').join('');

  return xmlResponse(200, '<ns2:SEARCH_RESULT_TYPE xmlns:ns2="http://www.nates.fr/API/1.0"><status>SUCCESS</status>' +
    '<totalNumberOfResults listIsNotComplete="' + String(!complete) + '" endOfListReached="' + String(complete) + '">' +
    page.length + '</totalNumberOfResults>' + devices + '</ns2:SEARCH_RESULT_TYPE>');
}

export const kurmiApi: MockApp = createApp('kurmi', 'api', [
  {
    method: 'POST',
    pattern: '/Kurmi/services/API',
    // Credentials are in the envelope, not a header: authentication is the
    // handler's job here, so the route is "public" to the kernel.
    public: true,
    handler: (req) => search(req.body),
  },
], (_status, _code, message) => soapFault(message));
