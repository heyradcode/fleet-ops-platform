/**
 * Bandwidth: the account API in XML, the carrier's trunk view, and what two
 * ends of one SBC can say that neither can alone.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now } from '../../platform/clock.ts';
import {
  BANDWIDTH_ACCOUNT, BANDWIDTH_PEERS, DEMO_BANDWIDTH_USER, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_CLIENT, DEMO_WEBEX_TOKEN,
  directory, mockFetch, resetMockState, TEAMS_PLANTED,
} from './mock/index.ts';
import { CommsHttpError, createCommsClient, type CommsCredentials } from './client.ts';
import { fetchPeerOutcomes, pullBandwidthTrunks, pullSipPeers } from './bandwidth.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from './config.ts';
import { evaluateSignals, localise } from './incidents.ts';
import type { CommsSignal } from './signals.ts';
import { PLANTED_WINDOW_MS } from './mock/time.ts';

beforeEach(() => {
  setClock(fixedClock());
  resetMockState();
});

function client(creds: Partial<CommsCredentials> = {}) {
  return createCommsClient({
    tenantId: HHS_DEMO_TENANT,
    fetch: mockFetch,
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
      genesys: { ...DEMO_CLIENT },
      webex: { token: DEMO_WEBEX_TOKEN },
      bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER },
      kurmi: { ...DEMO_KURMI_USER },
      starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
      ...creds,
    },
    sleep: async () => {},
  });
}

const window = () => ({
  from: new Date(now() - 30 * 60_000).toISOString(),
  to: new Date(now()).toISOString(),
});

test('SIP peers are read from the XML account API, across sites, with their hosts', async () => {
  const peers = await pullSipPeers(client(), BANDWIDTH_ACCOUNT);
  assert.deepEqual(peers.map((p) => p.peerId), BANDWIDTH_PEERS.map((p) => p.peerId));
  assert.deepEqual(peers[0].hosts, ['203.0.113.11']);
  assert.equal(peers[1].name, 'Teams DR - SBC2');
});

test('wrong Basic credentials are a 401 and are not retried', async () => {
  const c = client({ bandwidth: { username: DEMO_BANDWIDTH_USER.username, password: 'wrong' } });
  await assert.rejects(pullSipPeers(c, BANDWIDTH_ACCOUNT),
    (e: unknown) => e instanceof CommsHttpError && e.status === 401 && !e.retryable);
});

test('another account is refused, not quietly empty', async () => {
  await assert.rejects(pullSipPeers(client(), '1234567'),
    (e: unknown) => e instanceof CommsHttpError && e.status === 403);
});

test('mapped peers land on the SBC the Teams report names; the unmapped one keeps its own name', async () => {
  const { from, to } = window();
  const { trunks, unmappedPeers } = await pullBandwidthTrunks(client(), COMMS_CONFIG[HHS_DEMO_TENANT], from, to);
  const ids = trunks.map((t) => t.subjectId);
  assert.ok(ids.includes(TEAMS_PLANTED.failingTrunk), 'SBC2 keyed by its FQDN, like the Teams signal');
  assert.ok(ids.includes('bandwidth-peer:540103'), 'the legacy PBX trunk is kept, not dropped');
  assert.deepEqual(unmappedPeers, ['Legacy PBX - Austin (540103)']);
});

test('the dead SBC fails INBOUND at the carrier and falls silent outbound', async () => {
  const from = new Date(now() - PLANTED_WINDOW_MS).toISOString();
  const outcomes = await fetchPeerOutcomes(client(), BANDWIDTH_ACCOUNT, from, new Date(now()).toISOString());
  const sbc2 = (d: string) => outcomes.find((o) => o.peerId === '540102' && o.direction === d)!;
  const sbc1 = (d: string) => outcomes.find((o) => o.peerId === '540101' && o.direction === d)!;
  assert.ok(sbc2('inbound').failed / sbc2('inbound').attempts > 0.6);
  assert.ok(sbc2('outbound').attempts < sbc1('outbound').attempts / 4, 'a dead SBC stops sending');
  assert.ok(sbc1('inbound').failed / sbc1('inbound').attempts < 0.1);
});

test('the call-outcomes read refuses a window that ends in the future', async () => {
  const c = client();
  await assert.rejects(fetchPeerOutcomes(c, BANDWIDTH_ACCOUNT, new Date(now()).toISOString(),
    new Date(now() + 3600_000).toISOString()), (e: unknown) => e instanceof CommsHttpError && e.status === 400);
});

// ---------------------------------------------------------------------------
// Two ends of one SBC
// ---------------------------------------------------------------------------

const trunk = { kind: 'trunk' as const, id: 'sbc2.voice.hhs.texas.example', name: 'sbc2.voice.hhs.texas.example' };

test('localise: which end saw it says which leg is at fault', () => {
  assert.match(localise('trunk-call-failure', trunk, ['bandwidth', 'teams'], [])!, /Both legs/);
  assert.match(localise('trunk-call-failure', trunk, ['teams'], ['bandwidth'])!, /Carrier leg healthy/);
  assert.match(localise('trunk-call-failure', trunk, ['bandwidth'], ['teams'])!, /Teams leg healthy/);
  const pbx = { kind: 'trunk' as const, id: 'bandwidth-peer:540103', name: 'Legacy PBX - Austin' };
  assert.match(localise('trunk-call-failure', pbx, ['bandwidth'], [])!, /carrier only/);
  assert.equal(localise('trunk-call-failure', trunk, ['teams'], []), undefined, 'one view says nothing about where');
  assert.equal(localise('queue-backlog', trunk, ['genesys'], []), undefined);
});

test('a healthy carrier end LOCALISES a trunk alarm - it does not hold it back', () => {
  const base = {
    tenantId: 't', subject: trunk, kind: 'trunk-call-failure' as const, unit: 'ratio' as const, sampleSize: 30,
    window: { from: '2026-09-08T14:00:00.000Z', to: '2026-09-08T14:30:00.000Z' }, detail: '',
  };
  const signals: CommsSignal[] = [
    { ...base, signalId: 'a', source: 'teams', value: 0.6, severity: 'critical' },
    { ...base, signalId: 'b', source: 'bandwidth', value: 0.01, severity: 'ok' },
  ];
  const [alarm] = evaluateSignals(signals);
  assert.equal(alarm.corroborated, true, 'a trunk failing Teams calls is failing them');
  assert.deepEqual(alarm.dissent, ['bandwidth']);
  assert.match(alarm.localisation!, /Carrier leg healthy/);
});
