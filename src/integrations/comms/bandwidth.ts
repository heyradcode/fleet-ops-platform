/**
 * ---------------------------------------------------------------------------
 * Bandwidth: the carrier's view of the SIP trunks
 * ---------------------------------------------------------------------------
 * The Teams Direct Routing report sees a trunk from MICROSOFT's side: calls
 * Teams handed to the SBC, and what came back. Bandwidth sees the same trunk
 * from the CARRIER's side: calls the PSTN handed to the SBC, and calls the SBC
 * handed out. Same SBC, opposite ends of it.
 *
 * WHAT THAT BUYS, and it is two things, neither of them "permission to page":
 *
 *   1. The half of an outage Teams cannot see. When an SBC dies, inbound PSTN
 *      calls fail AT THE CARRIER. They never reach the SBC, so they never
 *      reach Teams, so the Teams report has no row for them - not a failed
 *      row, no row. Only the carrier witnesses them. That is the comms
 *      version of the network probe: the only thing that sees silence.
 *   2. Where the fault is. Both ends failing points at the SBC; only the Teams
 *      end failing points at Microsoft's side of it; only the carrier end at
 *      the carrier's. See `localise` in incidents.ts.
 *
 * Trunk failure stays SELF-EVIDENT - it pages on one source, because a trunk
 * failing calls is failing calls whoever counts them. Bandwidth is not a gate.
 *
 * THE CALL-OUTCOMES READ IS ONE FUNCTION, `fetchPeerOutcomes`, because its
 * shape is a placeholder until the Insights reference is in hand - see the
 * mock's header. Everything else here is independent of it.
 */
import { childText, childrenNamed, descendants, parseXml } from '../../platform/xml.ts';
import type { TenantId } from '../../platform/types.ts';
import type { CommsClient } from './client.ts';
import { fqdnKey, type CommsTenantConfig } from './types.ts';

export type SipPeer = { peerId: string; name: string; siteId: string; hosts: string[] };

export type PeerOutcome = {
  peerId: string;
  direction: 'inbound' | 'outbound';
  attempts: number;
  failed: number;
  sipCodes: Record<string, number>;
};

async function getXml(client: CommsClient, url: string) {
  const res = await client.request('bandwidth', url, { headers: { Accept: 'application/xml' } });
  return parseXml(await res.text());
}

/** Every SIP peer on the account, across every site. */
export async function pullSipPeers(client: CommsClient, accountId: string): Promise<SipPeer[]> {
  const base = client.endpoints.bandwidthApi + '/accounts/' + encodeURIComponent(accountId);
  const sites = descendants(await getXml(client, base + '/sites'), 'Site')
    .map((s) => childText(s, 'Id'))
    .filter((id): id is string => !!id);

  const peers: SipPeer[] = [];
  for (const siteId of sites) {
    const doc = await getXml(client, base + '/sites/' + encodeURIComponent(siteId) + '/sippeers');
    for (const p of descendants(doc, 'SipPeer')) {
      const peerId = childText(p, 'PeerId');
      if (!peerId) continue;
      const hosts = [
        ...childrenNamed(p, 'VoiceHosts').flatMap((v) => descendants(v, 'HostName')),
        ...childrenNamed(p, 'TerminationHosts').flatMap((v) => descendants(v, 'HostName')),
      ].map((h) => h.text.trim());
      peers.push({ peerId, name: childText(p, 'PeerName') ?? peerId, siteId, hosts: [...new Set(hosts)] });
    }
  }
  return peers;
}

/**
 * Call outcomes per SIP peer and direction, for a window.
 *
 * PLACEHOLDER SHAPE - the one function to change when the Insights reference
 * is available. Keep its RETURN type; the rest of the connector depends only
 * on that.
 */
export async function fetchPeerOutcomes(
  client: CommsClient, accountId: string, from: string, to: string,
): Promise<PeerOutcome[]> {
  const q = new URLSearchParams({ startTime: from, endTime: to, groupBy: 'location' });
  const res = await client.request('bandwidth',
    client.endpoints.bandwidthInsights + '/accounts/' + encodeURIComponent(accountId) + '/voice/summary?' + q);
  const body = await res.json() as {
    data: Array<{ locationId: string; direction: 'inbound' | 'outbound'; callAttempts: number; failedCalls: number; sipResponseCounts: Record<string, number> }>;
  };
  return body.data.map((d) => ({
    peerId: d.locationId,
    direction: d.direction,
    attempts: d.callAttempts,
    failed: d.failedCalls,
    sipCodes: d.sipResponseCounts,
  }));
}

/** One trunk's outcomes, both directions combined, ready to become a signal. */
export type TrunkOutcome = {
  /** The subject: the SBC FQDN when the peer maps to one, else the peer itself. */
  subjectId: string;
  subjectName: string;
  mapped: boolean;
  attempts: number;
  failed: number;
  byDirection: Record<'inbound' | 'outbound', { attempts: number; failed: number }>;
  failureCodes: string[];
};

/**
 * Pure. Peers and outcomes -> per-trunk totals, keyed onto the Teams subject.
 *
 * An UNMAPPED peer is kept, under its own name, not dropped: a legacy PBX
 * trunk with no Teams counterpart failing its calls is still an outage, and
 * silently discarding the carrier's only report of it is the failure this
 * whole integration exists to prevent.
 */
export function trunkOutcomes(
  peers: SipPeer[], outcomes: PeerOutcome[], config: CommsTenantConfig,
): { trunks: TrunkOutcome[]; unmappedPeers: string[] } {
  const table = config.bandwidth?.peerTrunk ?? {};
  const byPeer = new Map(peers.map((p) => [p.peerId, p]));
  const trunks = new Map<string, TrunkOutcome>();
  const unmapped = new Set<string>();

  for (const o of outcomes) {
    const fqdn = table[o.peerId] ? fqdnKey(table[o.peerId]) : undefined;
    const peer = byPeer.get(o.peerId);
    if (!fqdn) unmapped.add((peer?.name ?? o.peerId) + ' (' + o.peerId + ')');
    const subjectId = fqdn ?? 'bandwidth-peer:' + o.peerId;
    const t = trunks.get(subjectId) ?? {
      subjectId,
      subjectName: fqdn ?? (peer?.name ?? 'SIP peer ' + o.peerId),
      mapped: !!fqdn,
      attempts: 0,
      failed: 0,
      byDirection: { inbound: { attempts: 0, failed: 0 }, outbound: { attempts: 0, failed: 0 } },
      failureCodes: [],
    };
    t.attempts += o.attempts;
    t.failed += o.failed;
    t.byDirection[o.direction].attempts += o.attempts;
    t.byDirection[o.direction].failed += o.failed;
    for (const [code, n] of Object.entries(o.sipCodes)) {
      if (n > 0 && !code.startsWith('2') && !t.failureCodes.includes(code)) t.failureCodes.push(code);
    }
    t.failureCodes.sort();
    trunks.set(subjectId, t);
  }
  return {
    trunks: [...trunks.values()].sort((a, b) => a.subjectName.localeCompare(b.subjectName)),
    unmappedPeers: [...unmapped].sort(),
  };
}

export async function pullBandwidthTrunks(
  client: CommsClient, config: CommsTenantConfig, from: string, to: string,
): Promise<{ trunks: TrunkOutcome[]; unmappedPeers: string[]; tenantId: TenantId }> {
  const bw = config.bandwidth!;
  const peers = await pullSipPeers(client, bw.accountId);
  const outcomes = await fetchPeerOutcomes(client, bw.accountId, from, to);
  return { ...trunkOutcomes(peers, outcomes, config), tenantId: client.tenantId };
}
