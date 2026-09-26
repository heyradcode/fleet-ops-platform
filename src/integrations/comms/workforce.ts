/**
 * ---------------------------------------------------------------------------
 * The workforce: three platforms' accounts joined into people
 * ---------------------------------------------------------------------------
 * The first node type of the knowledge graph, and the customer's first ask:
 * split the voice users by AGENCY (from the email domain) and by FACILITY
 * (from Entra's `LC=` code, or the Webex Calling location).
 *
 * THE JOIN KEY IS THE LOWER-CASED EMAIL, because it is the only handle the
 * three share - Entra, Genesys and Webex each mint their own ids. That is a
 * weaker key than it looks: it fails for anyone whose address differs between
 * systems (a rename, a contractor with two domains), and those people show up
 * as two members with one account each. The report cannot detect that; a
 * name-and-number similarity check could, and is the obvious next step once
 * there is real data to tune it on.
 *
 * FACILITY PRECEDENCE: Entra first, Webex second. Entra's address is what HR
 * maintains; a Webex location is what a voice admin picked when assigning a
 * number, and is wrong more often. When both exist and disagree the member
 * keeps Entra's and the disagreement is REPORTED - it is usually a person who
 * moved buildings and whose phone did not.
 *
 * Genesys has no facility of its own. An employee inherits theirs from the
 * synced Entra directory (entra-directory.ts), looked up by a hash of their
 * address; a contractor, who is not in Entra, stays unplaced and is counted.
 */
import type { CommsClient } from './client.ts';
import { pullTeams, normaliseTeams } from './teams.ts';
import { EMPTY_DIRECTORY, type DirectoryStatus, type EntraDirectoryView } from './entra-directory.ts';
import { pullGenesys, normaliseGenesys } from './genesys.ts';
import { pullWebex, normaliseWebex } from './webex.ts';
import type {
  AgencyAssignment, CommsAccount, CommsSource, CommsTenantConfig, FacilitySource, UnplacedReason,
} from './types.ts';
import { COMMS_SOURCES, errorLine } from './types.ts';

export type WorkforceMember = {
  emailKey: string;
  displayName: string;
  /** Same for every account, because every account shares the domain. */
  agency: AgencyAssignment;
  accounts: Partial<Record<CommsSource, CommsAccount>>;
  facility?: { code: string; source: FacilitySource };
  unplaced?: UnplacedReason;
};

export type PlatformSplit = {
  /** Active PEOPLE on this platform. Resource accounts and inactive users excluded. */
  people: number;
  byAgency: Record<string, number>;
  contractorsByDomain: Record<string, number>;
  unknownByDomain: Record<string, number>;
  excluded: { resourceAccounts: number; inactive: number };
};

export type WorkforceReport = {
  tenantId: string;
  fetched: Partial<Record<CommsSource, { rows: number; pages: number; truncated: boolean }>>;
  members: WorkforceMember[];
  byPlatform: Partial<Record<CommsSource, PlatformSplit>>;
  /**
   * Active people per facility, per platform, sorted by code.
   *
   * An ARRAY, not a Record keyed by code: JavaScript iterates integer-like
   * keys first and in numeric order, so `1120` would come before `0412` (which
   * has a leading zero and is therefore a string key) however it was built.
   */
  byFacility: Array<{ code: string; counts: Partial<Record<CommsSource, number>> }>;
  unplaced: Array<{ email: string; sources: CommsSource[]; reason: UnplacedReason }>;
  facilityConflicts: Array<{ email: string; entra: string; webex: string }>;
  duplicateAccounts: Array<{ email: string; source: CommsSource; count: number }>;
  unmappedWebexLocations: string[];
  /** Whether facility placement had a complete Entra directory behind it. */
  directory: { status: DirectoryStatus; users: number };
  /**
   * Sources whose pull FAILED this poll, with the reason. Their columns are
   * absent from the split rather than zero - "we could not ask" is not "nobody
   * is there", and the health view is what says which.
   */
  errors: Partial<Record<CommsSource, string>>;
};

/** Pull every configured source, normalise, join. The one entry point. */
export async function buildWorkforce(
  client: CommsClient, config: CommsTenantConfig, directory: EntraDirectoryView,
): Promise<WorkforceReport> {
  const accounts: CommsAccount[] = [];
  const fetched: WorkforceReport['fetched'] = {};
  const errors: WorkforceReport['errors'] = {};
  let unmappedWebexLocations: string[] = [];

  // ONE SOURCE'S FAILURE IS THAT SOURCE'S, not the poll's. Before this, a
  // Genesys 503 threw out of here and took Teams, Webex and every incident
  // with it - the network side's "partial data beats no data" applies here
  // for the same reason.
  //
  // Sequential, not Promise.all. The three are independent, but a poll that
  // interleaves three services' requests is miserable to read in a log, and
  // this runs on a schedule where a second saved is worth nothing.
  const attempt = async (source: CommsSource, run: () => Promise<void>) => {
    if (!config.sources.includes(source)) return;
    try { await run(); } catch (err) { errors[source] = errorLine(err); }
  };
  await attempt('teams', async () => {
    const raw = await pullTeams(client);
    fetched.teams = {
      rows: raw.configurations.rows.length,
      pages: raw.configurations.pages,
      truncated: raw.configurations.truncated,
    };
    accounts.push(...normaliseTeams(raw, config, directory));
  });
  await attempt('genesys', async () => {
    const raw = await pullGenesys(client);
    fetched.genesys = { rows: raw.users.rows.length, pages: raw.users.pages, truncated: raw.users.truncated };
    accounts.push(...normaliseGenesys(raw, config));
  });
  await attempt('webex', async () => {
    const raw = await pullWebex(client);
    fetched.webex = {
      rows: raw.people.rows.length,
      pages: raw.people.pages + raw.locations.pages,
      truncated: raw.people.truncated || raw.locations.truncated,
    };
    const w = normaliseWebex(raw, config);
    accounts.push(...w.accounts);
    unmappedWebexLocations = w.unmappedLocations;
  });

  return {
    tenantId: config.tenantId, fetched, unmappedWebexLocations, errors,
    directory: { status: directory.status, users: directory.users },
    ...joinWorkforce(accounts, directory),
  };
}

/** Pure. Accounts -> people and the split. */
export function joinWorkforce(
  accounts: CommsAccount[],
  directory: EntraDirectoryView = EMPTY_DIRECTORY,
): Omit<WorkforceReport, 'tenantId' | 'fetched' | 'unmappedWebexLocations' | 'directory' | 'errors'> {
  const byKey = new Map<string, WorkforceMember>();
  const duplicates = new Map<string, { email: string; source: CommsSource; count: number }>();

  for (const a of accounts) {
    let m = byKey.get(a.emailKey);
    if (!m) {
      m = { emailKey: a.emailKey, displayName: a.displayName, agency: a.agency, accounts: {} };
      byKey.set(a.emailKey, m);
    }
    if (m.accounts[a.source]) {
      // Two accounts on one platform with one address. Keep the first, count
      // the rest - silently overwriting would make the count depend on order.
      const k = a.source + '|' + a.emailKey;
      const d = duplicates.get(k) ?? { email: a.email, source: a.source, count: 1 };
      d.count++;
      duplicates.set(k, d);
      continue;
    }
    m.accounts[a.source] = a;
    // Prefer a mixed-case display name over Genesys's upper-cased one.
    if (a.source !== 'genesys') m.displayName = a.displayName;
  }

  const facilityConflicts: WorkforceReport['facilityConflicts'] = [];
  for (const m of byKey.values()) {
    // Entra's placement covers everyone in Entra, voice-enabled or not; the
    // Teams account's own facility is the same fact for Teams Voice users.
    const inEntra = directory.placementByEmail(m.emailKey);
    const entra = m.accounts.teams?.facility ??
      (inEntra && 'code' in inEntra ? { code: inEntra.code, source: 'entra-street-address' as const } : undefined);
    const webex = m.accounts.webex?.facility;
    m.facility = entra ?? webex;
    if (entra && webex && entra.code !== webex.code) {
      facilityConflicts.push({ email: accountEmail(m), entra: entra.code, webex: webex.code });
    }
    if (!m.facility) {
      // An employee not found while the first sync is still running is not
      // "unplaceable", merely not placed YET - and saying so is the difference
      // between an ops lead waiting an hour and filing a data-quality ticket.
      const pending = directory.status === 'first-sync-in-progress' || directory.status === 'never-synced';
      m.unplaced = m.accounts.teams?.unplaced ??
        (inEntra && 'unplaced' in inEntra ? inEntra.unplaced : undefined) ??
        m.accounts.webex?.unplaced ??
        (pending && m.agency.kind === 'agency' ? 'directory-sync-incomplete' : 'no-facility-source');
    }
  }

  const members = [...byKey.values()].sort((a, b) => a.emailKey.localeCompare(b.emailKey));
  const byPlatform: WorkforceReport['byPlatform'] = {};
  const byFacility: Record<string, Partial<Record<CommsSource, number>>> = {};
  const unplaced: WorkforceReport['unplaced'] = [];

  for (const m of members) {
    const counted: CommsSource[] = [];
    for (const source of COMMS_SOURCES) {
      const a = m.accounts[source];
      if (!a) continue;
      const split = (byPlatform[source] ??= {
        people: 0, byAgency: {}, contractorsByDomain: {}, unknownByDomain: {},
        excluded: { resourceAccounts: 0, inactive: 0 },
      });
      if (a.kind === 'resource') { split.excluded.resourceAccounts++; continue; }
      if (!a.active) { split.excluded.inactive++; continue; }

      split.people++;
      const g = m.agency;
      if (g.kind === 'agency') bump(split.byAgency, g.agency);
      else if (g.kind === 'contractor') bump(split.contractorsByDomain, g.domain);
      else bump(split.unknownByDomain, g.domain);

      if (m.facility) bump((byFacility[m.facility.code] ??= {}), source);
      counted.push(source);
    }
    if (!m.facility && counted.length > 0) {
      unplaced.push({ email: accountEmail(m), sources: counted, reason: m.unplaced ?? 'no-facility-source' });
    }
  }

  return {
    members,
    byPlatform,
    byFacility: Object.keys(byFacility).sort().map((code) => ({ code, counts: byFacility[code] })),
    unplaced,
    facilityConflicts,
    duplicateAccounts: [...duplicates.values()],
  };
}

function bump<K extends string>(counts: Partial<Record<K, number>>, key: K): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** The address as some platform holds it, for a human to search for. */
function accountEmail(m: WorkforceMember): string {
  return (m.accounts.teams ?? m.accounts.webex ?? m.accounts.genesys)?.email ?? m.emailKey;
}
