/**
 * Kurmi over SOAP: escaping, "200 is not success", partitioning in place of
 * unknown paging, and the normalisation the one real sample demanded.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now, nowIso } from '../../platform/clock.ts';
import type { Principal } from '../../platform/types.ts';
import { childText, descendants, parseXml } from '../../platform/xml.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_WEBEX_TOKEN, directory,
  injectFault, KURMI_TENANT_DBID, kurmiPhones, mockFetch, resetMockState, setKurmiMaxResults,
} from './mock/index.ts';
import { CommsHttpError, createCommsClient, type CommsCredentials } from './client.ts';
import { normalisePhone, parseSearch, pullKurmiDevices, pullPhoneInventory, searchEnvelope } from './kurmi.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { runCommsPoll } from './poll.ts';
import { mainTable } from '../../aws/dynamodb.ts';

beforeEach(() => {
  setClock(fixedClock());
  resetMockState();
});

function client(kurmi: CommsCredentials['kurmi'] = { ...DEMO_KURMI_USER }, tenantId = HHS_DEMO_TENANT) {
  return createCommsClient({
    tenantId, fetch: mockFetch,
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
      genesys: { ...DEMO_CLIENT },
      webex: { token: DEMO_WEBEX_TOKEN },
      bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER },
      kurmi,
    },
    sleep: async () => {},
  });
}

const kurmiConfig = () => COMMS_CONFIG[HHS_DEMO_TENANT].kurmi!;

test('every value in the envelope is escaped - an injection attempt stays one password', () => {
  const evil = 'p<a>ss&"</password><password>x';
  const doc = parseXml(searchEnvelope({ login: 'u', password: evil }, '1', 'SEP'));
  const auth = descendants(doc, 'auth')[0];
  assert.equal(childText(auth, 'password'), evil);
  assert.equal(descendants(doc, 'password').length, 1, 'no second password element');
});

test('HTTP 200 with a FAILURE status is a failure, and is not retried', async () => {
  const c = client({ login: DEMO_KURMI_USER.login, password: 'wrong' });
  await assert.rejects(pullKurmiDevices(c, KURMI_TENANT_DBID),
    (e: unknown) => e instanceof CommsHttpError && e.status === 200 && !e.retryable && /FAILURE/.test(e.message));
});

test('a SOAP Fault is a failure, whatever else the body holds', () => {
  const fault = '<S:Envelope xmlns:S="x"><S:Body><S:Fault><faultcode>S:Client</faultcode>' +
    '<faultstring>Unmarshalling Error</faultstring></S:Fault></S:Body></S:Envelope>';
  assert.throws(() => parseSearch(fault), /SOAP Fault: Unmarshalling Error/);
});

test('a truncated search is partitioned by MAC prefix until the whole estate is in hand', async () => {
  const r = await pullKurmiDevices(client(), KURMI_TENANT_DBID);
  assert.equal(r.truncated, false);
  assert.equal(r.searches, 17, 'one truncated search, then sixteen slices');
  assert.equal(r.devices.length, kurmiPhones().length);
  assert.equal(new Set(r.devices.map((d) => d.attrs.dbid)).size, r.devices.length, 'no duplicates');
});

test('a slice still truncated at the depth limit makes the inventory INCOMPLETE - loudly', async () => {
  setKurmiMaxResults(0);
  const inv = await pullPhoneInventory(client(), COMMS_CONFIG[HHS_DEMO_TENANT], nowIso());
  assert.equal(inv.truncated, true);
  assert.equal(inv.searches, 1 + 16 + 256);
});

test('normalisation: case, blanks, unknown codes, trailing slashes, missing leaves, the technical value', async () => {
  const { devices } = await pullKurmiDevices(client(), KURMI_TENANT_DBID);
  const truth = new Map(kurmiPhones().map((p) => [p.dbid, p]));
  const cfg = kurmiConfig();
  for (const d of devices) {
    const phone = normalisePhone(d, cfg);
    const t = truth.get(phone.dbid)!;
    assert.equal(phone.disabled, t.disabled, 'from technicalValue, not the "Yes"/"No" label');
    if (t.agency === 'dshs') assert.deepEqual(phone.agency, { kind: 'agency', agency: 'DSHS' });
    if (t.agency === '') assert.deepEqual(phone.agency, { kind: 'blank' });
    if (t.agency === 'OIG') assert.deepEqual(phone.agency, { kind: 'unknown-code', code: 'OIG' });
    if (t.department === '/HHS/R-North/F-DAL1455/') assert.equal(phone.facility, '1455');
    if (t.department === '/HHS/R-Gulf') assert.equal(phone.unplaced, 'no-facility-leaf');
    if (t.department === '/HHS/R-Central/F-AUS0999') {
      assert.equal(phone.unplaced, 'unmapped-department');
      assert.equal(phone.departmentLeaf, 'F-AUS0999');
    }
  }
});

test('Kurmi down costs Kurmi only; its gaps are data-quality items with fixes; nothing device-level is stored', async () => {
  const tenantId = 'k-poll';
  const principal: Principal = {
    sub: 't', email: 'ops@hhs.texas.example', tenantId, roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
  };
  const config = { ...structuredClone(COMMS_CONFIG[HHS_DEMO_TENANT]), tenantId };

  const ok = await runCommsPoll(principal, client(undefined, tenantId), config, now());
  const kinds = ok.health.dataQuality.map((q) => q.kind);
  for (const k of ['unknown-agency-code', 'blank-agency', 'unmapped-kurmi-department', 'kurmi-no-facility']) {
    assert.ok(kinds.includes(k as never), k);
  }
  assert.ok(!JSON.stringify(mainTable.get('TENANT#' + tenantId + '#COMMS', 'PHONES#LATEST')).includes('SEP'),
    'no device names at rest - counts only');

  injectFault('kurmi', 503, 1000);
  const down = await runCommsPoll(principal, client(undefined, tenantId), config, now());
  const kurmi = down.health.sources.find((s) => s.source === 'kurmi')!;
  assert.equal(kurmi.status, 'down');
  assert.equal(down.incidents.length, 3, 'the comms incidents are untouched');
});
