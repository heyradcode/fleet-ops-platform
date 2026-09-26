/**
 * ---------------------------------------------------------------------------
 * Bandwidth (SIP trunking carrier) - the mock
 * ---------------------------------------------------------------------------
 * Two hosts:
 *
 *   api.bandwidth.com        GET /api/accounts/{accountId}/sites
 *                            GET /api/accounts/{accountId}/sites/{siteId}/sippeers
 *   insights.bandwidth.com   GET /api/v1/accounts/{accountId}/voice/summary      PLACEHOLDER
 *
 * TWO LEVELS OF CONFIDENCE, and the difference matters:
 *
 *   The ACCOUNT API is modelled from Bandwidth's published docs: XML bodies,
 *   Basic auth, an account holding sub-accounts ("sites") holding locations
 *   ("SIP peers"), with `PeerId`, `PeerName`, `IsDefaultPeer`. Element names
 *   below the peer (hosts) are from memory of that reference - verify them.
 *
 *   The CALL-OUTCOMES endpoint is a PLACEHOLDER. Bandwidth's Insights API
 *   exposes completed/failed calls and connection rates by direction and
 *   sub-account, but its paths and field names were not available when this
 *   was written. The connector reads it in exactly one function, so the real
 *   shape is a change there and here, nowhere else. Its per-SIP-PEER grouping
 *   is also an assumption: if Insights only groups by sub-account, give each
 *   SBC its own sub-account and key the tenant's `peerTrunk` table by that.
 *
 * NOT the CDR API: that returns the last DAILY report, which is a billing
 * artefact, not something to detect an outage from.
 *
 * Addresses are from 203.0.113.0/24 (TEST-NET-3, RFC 5737). Nothing real.
 *
 * WHAT IS PLANTED, and why it matters more than it looks: for the last forty
 * minutes SBC2 is failing, so the carrier cannot deliver INBOUND calls to it -
 * they fail at Bandwidth with SIP 503 and 408. Those calls never reach the SBC,
 * so they never reach Teams, so the Teams Direct Routing report has NO ROW for
 * them. The carrier is the only witness to that half of the outage.
 */
import { now } from '../../../platform/clock.ts';
import { escapeXml } from '../../../platform/xml.ts';
import { createApp, type MockApp, type MockRequest, type MockResponse } from './kernel.ts';
import { streamFor } from './directory.ts';
import { ACTIVITY_WINDOW_MS, activityAnchor, activityKey, PLANTED_WINDOW_MS, plantedActive } from './time.ts';

export const BANDWIDTH_ACCOUNT = '9900001';
const SITE = { id: '88001', name: 'HHS Voice', description: 'Teams Direct Routing and legacy PBX trunks' };

export const BANDWIDTH_PEERS = [
  { peerId: '540101', name: 'Teams DR - SBC1', host: '203.0.113.11', isDefault: true },
  { peerId: '540102', name: 'Teams DR - SBC2', host: '203.0.113.12', isDefault: false },
  { peerId: '540103', name: 'Legacy PBX - Austin', host: '203.0.113.20', isDefault: false },
] as const;

export const BANDWIDTH_PLANTED = { failingPeerId: '540102' } as const;

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xml(status: number, body: string): MockResponse {
  return { status, xml: true, body: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body };
}

const el = (name: string, value: string) => '<' + name + '>' + escapeXml(value) + '</' + name + '>';

/**
 * The account API's error envelope. Modelled on its `ResponseStatus` block;
 * the outer element name varies by endpoint in the real API.
 */
function bandwidthError(status: number, _code: string, message: string): MockResponse {
  return xml(status, '<ErrorResponse><ResponseStatus>' +
    el('ErrorCode', String(status === 401 ? 12001 : status === 404 ? 12404 : status === 429 ? 12429 : 12500)) +
    el('Description', message) + '</ResponseStatus></ErrorResponse>');
}

function checkAccount(accountId: string): MockResponse | undefined {
  return accountId === BANDWIDTH_ACCOUNT ? undefined : bandwidthError(403, '', 'Account ' + accountId + ' is not accessible to this user');
}

export const bandwidthApi: MockApp = createApp('bandwidth', 'api', [
  {
    method: 'GET',
    pattern: '/api/accounts/:accountId/sites',
    handler(_req, { accountId }) {
      const denied = checkAccount(accountId);
      if (denied) return denied;
      return xml(200, '<SitesResponse><Sites><Site>' + el('Id', SITE.id) + el('Name', SITE.name) +
        el('Description', SITE.description) + '</Site></Sites></SitesResponse>');
    },
  },
  {
    method: 'GET',
    pattern: '/api/accounts/:accountId/sites/:siteId/sippeers',
    handler(_req, { accountId, siteId }) {
      const denied = checkAccount(accountId);
      if (denied) return denied;
      if (siteId !== SITE.id) return bandwidthError(404, '', 'Site ' + siteId + ' not found');
      const peers = BANDWIDTH_PEERS.map((p) => '<SipPeer>' +
        el('PeerId', p.peerId) + el('PeerName', p.name) + el('IsDefaultPeer', String(p.isDefault)) +
        '<VoiceHosts><Host>' + el('HostName', p.host) + '</Host></VoiceHosts>' +
        '<TerminationHosts><TerminationHost>' + el('HostName', p.host) + el('Port', '5061') +
        '</TerminationHost></TerminationHosts></SipPeer>').join('');
      return xml(200, '<TNSipPeersResponse><SipPeers>' + peers + '</SipPeers></TNSipPeersResponse>');
    },
  },
], (status, code, message) => bandwidthError(status, code, message));

// ---------------------------------------------------------------------------
// Call outcomes - PLACEHOLDER shape, see the header
// ---------------------------------------------------------------------------

type Attempt = { peerId: string; at: number; direction: 'inbound' | 'outbound'; failed: boolean; sip: number };

let cache: { anchor: number; attempts: Attempt[] } | undefined;

function attempts(): Attempt[] {
  const anchor = activityAnchor();
  if (cache?.anchor !== activityKey()) cache = { anchor: activityKey(), attempts: generate(anchor) };
  return cache.attempts;
}

function generate(anchor: number): Attempt[] {
  const rng = streamFor('bandwidth-activity', anchor);
  const incidentFrom = anchor - PLANTED_WINDOW_MS;
  const out: Attempt[] = [];
  for (const peer of BANDWIDTH_PEERS) {
    const base = peer.peerId === '540103' ? 0.3 : 1.1;   // per minute, per direction
    for (let t = anchor - ACTIVITY_WINDOW_MS; t < anchor; t += 60_000) {
      const planted = plantedActive() && peer.peerId === BANDWIDTH_PLANTED.failingPeerId && t >= incidentFrom;
      for (const direction of ['inbound', 'outbound'] as const) {
        // A dead SBC stops SENDING, so outbound all but vanishes; inbound
        // keeps arriving from the PSTN and fails at the carrier.
        const rate = planted && direction === 'outbound' ? base * 0.05 : base;
        let n = Math.floor(rate) + (rng() < rate % 1 ? 1 : 0);
        while (n-- > 0) {
          const failed = planted && direction === 'inbound' ? rng() < 0.85 : rng() < 0.01;
          out.push({
            peerId: peer.peerId,
            at: t + Math.floor(rng() * 60_000),
            direction,
            failed,
            sip: !failed ? 200 : planted ? (rng() < 0.7 ? 503 : 408) : 486,
          });
        }
      }
    }
  }
  return out;
}

function summary(req: MockRequest, accountId: string): MockResponse {
  const denied = checkAccount(accountId);
  if (denied) return { status: 403, body: { errors: [{ code: 'forbidden', message: 'account not accessible' }] } };
  const from = Date.parse(req.query.get('startTime') ?? '');
  const to = Date.parse(req.query.get('endTime') ?? '');
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
    return { status: 400, body: { errors: [{ code: 'invalid-time-range', message: 'startTime and endTime are required, startTime < endTime' }] } };
  }
  if (to > now() + 60_000) {
    return { status: 400, body: { errors: [{ code: 'invalid-time-range', message: 'endTime is in the future' }] } };
  }
  if ((req.query.get('groupBy') ?? 'location') !== 'location') {
    return { status: 400, body: { errors: [{ code: 'not-modelled', message: 'mock models groupBy=location only' }] } };
  }

  const groups = new Map<string, { locationId: string; siteId: string; direction: string; callAttempts: number; completedCalls: number; failedCalls: number; sipResponseCounts: Record<string, number> }>();
  for (const a of attempts()) {
    if (a.at < from || a.at >= to) continue;
    const k = a.peerId + '|' + a.direction;
    const g = groups.get(k) ?? {
      locationId: a.peerId, siteId: SITE.id, direction: a.direction,
      callAttempts: 0, completedCalls: 0, failedCalls: 0, sipResponseCounts: {},
    };
    g.callAttempts++;
    if (a.failed) g.failedCalls++; else g.completedCalls++;
    g.sipResponseCounts[String(a.sip)] = (g.sipResponseCounts[String(a.sip)] ?? 0) + 1;
    groups.set(k, g);
  }
  const data = [...groups.values()].sort((a, b) => (a.locationId + a.direction).localeCompare(b.locationId + b.direction));
  return {
    status: 200,
    body: { meta: { startTime: new Date(from).toISOString(), endTime: new Date(to).toISOString(), groupBy: 'location' }, data },
  };
}

export const bandwidthInsights: MockApp = createApp('bandwidth', 'insights', [
  {
    method: 'GET',
    pattern: '/api/v1/accounts/:accountId/voice/summary',
    handler: (req, { accountId }) => summary(req, accountId),
  },
], (status, _code, message) => ({ status, body: { errors: [{ code: 'error', message }] } }));
