/**
 * ---------------------------------------------------------------------------
 * Integration health: is every feed answering, and is what it says usable?
 * ---------------------------------------------------------------------------
 * Two different questions, kept apart because they send different people:
 *
 *   SOURCE HEALTH   is Graph / Genesys / Webex / Bandwidth / Helix answering,
 *                   and since when has it not been? -> whoever owns the
 *                   integration, or the vendor.
 *   DATA QUALITY    it answered, but some of what it said cannot be used - an
 *                   email domain nobody configured, a Webex location or SIP
 *                   peer with no mapping. -> whoever owns the tenant's
 *                   configuration, with the exact fix named.
 *
 * STATUS IS DELIBERATELY COARSE:
 *   healthy         answered, nothing missing
 *   degraded        answered, but with a KNOWN GAP this poll - a truncated
 *                   listing, a directory sync not yet finished
 *   down            failed this poll; `stale` once the last good data is old
 *   not-configured  the tenant does not run it
 *
 * CAVEATS ARE NOT A STATUS. Bandwidth's call-outcomes API is a placeholder
 * shape until the Insights reference is in hand; that is permanently true and
 * says nothing about THIS poll. Making it "degraded" would paint the tile
 * amber forever, and a light that is always amber teaches people to ignore
 * amber - the one colour on this board that has to keep meaning something.
 *
 * STALE is what makes "down" actionable. One failed poll is a blip the next
 * poll usually fixes; data that has not refreshed for fifteen minutes means
 * the incidents on the board may no longer describe the present.
 */
import { mainTable } from '../../aws/dynamodb.ts';
import { pk } from '../../platform/tenancy.ts';
import type { Principal } from '../../platform/types.ts';
import { requireTenantScope } from './store.ts';
import type { ApiSource } from './client.ts';
import type { EntraSyncResult } from './entra-directory.ts';
import type { CommsTenantConfig } from './types.ts';
import type { WorkforceReport } from './workforce.ts';
import type { PhoneInventory } from './kurmi.ts';
import type { RegistrationReport } from './cucm.ts';
import type { StaffingSnapshot } from './staffing.ts';

/** Every feed the health view tracks. The directory sync is its own row: it can fail while Teams answers. */
export type HealthSource = ApiSource | 'entra-directory';

export const HEALTH_SOURCES: readonly HealthSource[] = [
  'entra-directory', 'teams', 'genesys', 'webex', 'bandwidth', 'helix', 'kurmi', 'cucm', 'starlink',
];

export type SourceStatus = 'healthy' | 'degraded' | 'down' | 'not-configured';

export type SourceHealth = {
  source: HealthSource;
  status: SourceStatus;
  /** Down, and the last good data is older than STALE_AFTER_MS (or there never was any). */
  stale: boolean;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
  lastError?: string;
  /** Known gaps THIS poll - why it is degraded. */
  gaps: string[];
  /** Permanent limits, shown dimmed. Never a status. */
  caveats: string[];
};

export type DataQualityIssue = {
  kind: 'unknown-domain' | 'unmapped-webex-location' | 'unmapped-bandwidth-peer' | 'facility-conflict' | 'unplaced'
    | 'unknown-agency-code' | 'blank-agency' | 'unmapped-kurmi-department' | 'kurmi-no-facility'
    | 'unmapped-starlink-terminal' | 'dormant-desk-phone' | 'no-registration-record';
  count: number;
  detail: string;
  /** The fix, in words someone can act on. */
  action: string;
};

export type IntegrationHealth = { asOf: string; sources: SourceHealth[]; dataQuality: DataQualityIssue[] };

/** Three missed five-minute polls. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** What one poll observed about one source. Built by the poll, turned into health here. */
export type SourceRun = { source: HealthSource; configured: boolean; error?: string; gaps: string[]; caveats: string[] };

const CAVEATS: Partial<Record<HealthSource, string[]>> = {
  bandwidth: ['call-outcomes API shape is a PLACEHOLDER until the Insights reference is verified'],
  helix: ['field names are unverified against the customer\'s (customised) Helix forms'],
  kurmi: ['modelled from ONE sample - no schema yet; paging unknown, so searches are partitioned by MAC prefix'],
  starlink: ['the stream advances on SEND - raw bodies are archived before parsing; one service account per environment'],
  cucm: ['modelled from Cisco\'s published RisPort70 reference, not a live cluster; the request allowance is the cluster\'s, shared - our share is configured'],
};

/** What this poll saw, per source, from the pieces the poll already has. Pure. */
export function observeRun(args: {
  config: CommsTenantConfig;
  directorySync?: EntraSyncResult;
  directoryError?: string;
  report: WorkforceReport;
  signalErrors: Partial<Record<ApiSource, string>>;
  /** Sources not asked this poll, and why - a gap, never "down". */
  signalNotAsked?: Partial<Record<ApiSource, string>>;
  helixError?: string;
  kurmiError?: string;
  phones?: PhoneInventory;
  deskPhones?: RegistrationReport;
  /** Queue staffing could not be refreshed - a gap on Genesys, the last copy still served. */
  staffingError?: string;
  staffing?: StaffingSnapshot;
}): SourceRun[] {
  const { config, report } = args;
  const run = (source: HealthSource, configured: boolean, error: string | undefined, gaps: string[]): SourceRun =>
    ({ source, configured, error, gaps, caveats: CAVEATS[source] ?? [] });
  const joinErrors = (...e: Array<string | undefined>) => e.filter(Boolean).join('; ') || undefined;
  const truncated = (s: 'teams' | 'genesys' | 'webex') =>
    report.fetched[s]?.truncated ? ['listing truncated at the page ceiling - counts are LOW'] : [];

  const directoryGaps = args.directorySync?.status === 'first-sync-in-progress'
    ? ['first full sync still in progress - facility placement incomplete']
    : args.directorySync?.status === 'resyncing'
      ? ['resyncing after an expired delta token - serving the previous copy']
      : [];

  return [
    run('entra-directory', config.sources.includes('teams'), args.directoryError, directoryGaps),
    run('teams', config.sources.includes('teams'), joinErrors(report.errors.teams, args.signalErrors.teams), truncated('teams')),
    run('genesys', config.sources.includes('genesys'), joinErrors(report.errors.genesys, args.signalErrors.genesys), [
      ...truncated('genesys'),
      ...(args.staffingError ? [args.staffingError] : []),
      ...(args.staffing?.queues.some((q) => q.truncated)
        ? ['a queue\'s member listing was truncated at the page ceiling - its staffing counts are LOW'] : []),
    ]),
    run('webex', config.sources.includes('webex'), joinErrors(report.errors.webex, args.signalErrors.webex), truncated('webex')),
    run('bandwidth', !!config.bandwidth, args.signalErrors.bandwidth, []),
    run('helix', !!config.helix, args.helixError, []),
    run('starlink', !!config.starlink, args.signalErrors.starlink, []),
    run('kurmi', !!config.kurmi, args.kurmiError,
      args.phones?.truncated ? ['a MAC-prefix slice was still truncated at the depth limit - phone counts are LOW'] : []),
    run('cucm', !!config.cucm, args.signalErrors.cucm, [
      ...(args.signalNotAsked?.cucm ? [args.signalNotAsked.cucm] : []),
      ...(args.deskPhones?.unmeasuredFacilities.length
        ? ['request budget reached - not measured this poll: ' + args.deskPhones.unmeasuredFacilities.map((f) => 'LC=' + f).join(', ')]
        : []),
    ]),
  ];
}

/**
 * At most this many issues of one kind are LISTED; the rest roll up into one
 * issue that counts them and names the same fix.
 *
 * Not tidiness - the list is stored as ONE item, and a tenant's first day is
 * when it is longest: every mapping table is empty, so every Webex location,
 * Kurmi department and SIP peer is "unmapped". Unbounded, that passes
 * DynamoDB's 400 KB item limit, the health write throws, and the poll dies
 * at the moment someone is watching it most closely. Bounded, it is also a
 * work list: fix these twenty, and the next poll lists the next twenty.
 */
export const MAX_ISSUES_PER_KIND = 20;

/** The fix for everything a roll-up stands for - the same as each listed one's. */
const ROLL_UP_ACTION: Partial<Record<DataQualityIssue['kind'], string>> = {
  'unknown-domain': 'Add each to the tenant\'s agencyDomains (an agency) or contractorDomains.',
  'unmapped-webex-location': 'Add each to the tenant\'s webexLocationFacility table with its LC code.',
  'unmapped-bandwidth-peer': 'If a peer carries a Teams SBC, add its peer id to bandwidth.peerTrunk.',
  'unmapped-kurmi-department': 'Add each to kurmi.departmentFacility with its LC code.',
  'unmapped-starlink-terminal': 'Add each fixed site\'s terminal to starlink.terminalFacility with its LC code.',
  'unknown-agency-code': 'Add each to kurmi.agencyCodes, or correct param2 on those devices in Kurmi.',
};

/** Keep the first MAX_ISSUES_PER_KIND of each kind, in order; roll up the rest. Pure. */
export function boundIssues(issues: DataQualityIssue[]): DataQualityIssue[] {
  const seen = new Map<DataQualityIssue['kind'], number>();
  const rest = new Map<DataQualityIssue['kind'], { items: number; count: number }>();
  const out: DataQualityIssue[] = [];
  for (const i of issues) {
    const n = (seen.get(i.kind) ?? 0) + 1;
    seen.set(i.kind, n);
    if (n <= MAX_ISSUES_PER_KIND) { out.push(i); continue; }
    const r = rest.get(i.kind) ?? { items: 0, count: 0 };
    rest.set(i.kind, { items: r.items + 1, count: r.count + i.count });
  }
  for (const [kind, r] of rest) {
    out.push({
      kind, count: r.count,
      detail: '...and ' + r.items + ' more ' + kind.replace(/-/g, ' ') + ' issue(s) not listed here',
      action: (ROLL_UP_ACTION[kind] ?? 'The same fix as those listed.') + ' Fix the ones listed, and the next poll lists the next.',
    });
  }
  return out;
}

/** Data-quality issues with their fixes, bounded per kind (boundIssues). Pure. */
export function dataQuality(
  report: WorkforceReport, unmappedBandwidthPeers: string[], phones?: PhoneInventory,
  unmappedStarlinkTerminals: string[] = [], deskPhones?: RegistrationReport,
): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  if (deskPhones?.dormant) {
    issues.push({
      kind: 'dormant-desk-phone', count: deskPhones.dormant,
      detail: deskPhones.dormant + ' Cisco desk phone(s) unregistered for over a week',
      action: 'Reclaim them in Kurmi, or find out why they are unplugged; until then they are left out of the registration rate.',
    });
  }
  if (deskPhones?.noRecord) {
    issues.push({
      kind: 'no-registration-record', count: deskPhones.noRecord,
      detail: deskPhones.noRecord + ' Cisco desk phone(s) in Kurmi that CUCM has no registration record for',
      action: 'Check they are provisioned on this CUCM cluster (Kurmi can feed more than one) and have ever been plugged in.',
    });
  }
  for (const t of unmappedStarlinkTerminals) {
    issues.push({
      kind: 'unmapped-starlink-terminal', count: 1, detail: 'Starlink terminal ' + t,
      action: 'If it serves a fixed site, add ' + t + ' to starlink.terminalFacility with its LC code; ' +
        'a mobile unit can stay unmapped - its signals arrive under its own id.',
    });
  }

  const unknown = new Map<string, number>();
  for (const split of Object.values(report.byPlatform)) {
    for (const [domain, n] of Object.entries(split?.unknownByDomain ?? {})) unknown.set(domain, (unknown.get(domain) ?? 0) + n);
  }
  for (const [domain, n] of [...unknown].sort()) {
    issues.push({
      kind: 'unknown-domain', count: n, detail: n + ' account(s) at ' + domain,
      action: 'Add ' + domain + ' to the tenant\'s agencyDomains (an agency) or contractorDomains.',
    });
  }
  for (const loc of report.unmappedWebexLocations) {
    issues.push({
      kind: 'unmapped-webex-location', count: 1, detail: 'Webex location "' + loc + '"',
      action: 'Add "' + loc + '" to the tenant\'s webexLocationFacility table with its LC code.',
    });
  }
  for (const peer of unmappedBandwidthPeers) {
    issues.push({
      kind: 'unmapped-bandwidth-peer', count: 1, detail: 'SIP peer ' + peer,
      action: 'If this peer carries a Teams SBC, add its peer id to bandwidth.peerTrunk; ' +
        'otherwise nothing to do - its signals already arrive under its own name.',
    });
  }
  if (report.facilityConflicts.length > 0) {
    issues.push({
      kind: 'facility-conflict', count: report.facilityConflicts.length,
      detail: report.facilityConflicts.length + ' person(s) placed differently by Entra and Webex',
      action: 'Usually a move: update the Webex Calling location, or the Entra street address.',
    });
  }
  if (phones) {
    for (const [code, n] of Object.entries(phones.unknownAgencyCodes).sort()) {
      issues.push({
        kind: 'unknown-agency-code', count: n, detail: n + ' Cisco phone(s) with Kurmi agency "' + code + '"',
        action: 'Either add "' + code + '" to kurmi.agencyCodes, or correct param2 on those devices in Kurmi.',
      });
    }
    if (phones.blankAgency > 0) {
      issues.push({
        kind: 'blank-agency', count: phones.blankAgency, detail: phones.blankAgency + ' Cisco phone(s) with no agency (param2 empty)',
        action: 'Set param2 on those devices in Kurmi to HHSC, DSHS or DFPS.',
      });
    }
    for (const leaf of phones.unmappedDepartments) {
      issues.push({
        kind: 'unmapped-kurmi-department', count: 1, detail: 'Kurmi department "' + leaf + '"',
        action: 'Add "' + leaf + '" to kurmi.departmentFacility with its LC code.',
      });
    }
    const noLeaf = phones.unplaced['no-facility-leaf'] ?? 0;
    if (noLeaf > 0) {
      issues.push({
        kind: 'kurmi-no-facility', count: noLeaf, detail: noLeaf + ' Cisco phone(s) whose department stops at the region',
        action: 'Assign those devices a facility-level kurmiDepartment in Kurmi.',
      });
    }
  }

  const unplaced = new Map<string, number>();
  for (const u of report.unplaced) unplaced.set(u.reason, (unplaced.get(u.reason) ?? 0) + 1);
  const actionFor: Record<string, string> = {
    'no-facility-code': 'Add "LC=NNNN" to the person\'s Entra street address.',
    'malformed-facility-code': 'Fix the Entra street address to read exactly "LC=NNNN".',
    'no-facility-source': 'Expected for contractors; for an employee, check they exist in Entra.',
    'directory-sync-incomplete': 'Nothing - resolves when the first directory sync completes.',
    'no-webex-location': 'Assign the Webex Calling user a location.',
    'unmapped-webex-location': 'See the unmapped Webex location above.',
    'not-in-directory': 'The Teams account has no Entra user - check for a deleted or renamed user.',
  };
  for (const [reason, n] of [...unplaced].sort()) {
    issues.push({
      kind: 'unplaced', count: n, detail: n + ' person(s): ' + reason.replace(/-/g, ' '),
      action: actionFor[reason] ?? 'Review.',
    });
  }
  return boundIssues(issues);
}

const healthPk = (p: Principal) => pk(p, 'COMMS');
const sourceSk = (s: HealthSource) => 'HEALTH#SOURCE#' + s;
const QUALITY_SK = 'HEALTH#QUALITY';

/**
 * Fold this poll's observations into the stored records and return the result.
 *
 * lastSuccessAt and consecutiveFailures CARRY ACROSS POLLS - that is the
 * whole point: "down" with a success two minutes ago and "down" with none for
 * an hour are different situations, and only the history can tell them apart.
 */
export async function recordHealth(
  principal: Principal, at: number, runs: SourceRun[], quality: DataQualityIssue[],
): Promise<IntegrationHealth> {
  const nowIso = new Date(at).toISOString();
  // Independent keys, so the reads go in parallel: one round trip, not eight.
  const previous = await Promise.all(runs.map((r) => mainTable.get(healthPk(principal), sourceSk(r.source))));
  const sources = runs.map((r, n): SourceHealth => {
    const prev = previous[n] as unknown as SourceHealth | undefined;
    if (!r.configured) {
      return { source: r.source, status: 'not-configured', stale: false, lastAttemptAt: nowIso, consecutiveFailures: 0, gaps: [], caveats: [] };
    }
    if (r.error) {
      const lastSuccessAt = prev?.lastSuccessAt;
      return {
        source: r.source, status: 'down',
        stale: !lastSuccessAt || at - Date.parse(lastSuccessAt) > STALE_AFTER_MS,
        lastAttemptAt: nowIso, lastSuccessAt,
        consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
        lastError: r.error, gaps: r.gaps, caveats: r.caveats,
      };
    }
    return {
      source: r.source, status: r.gaps.length > 0 ? 'degraded' : 'healthy', stale: false,
      lastAttemptAt: nowIso, lastSuccessAt: nowIso, consecutiveFailures: 0,
      gaps: r.gaps, caveats: r.caveats,
    };
  });

  await Promise.all([
    ...sources.map((s) => mainTable.put({ PK: healthPk(principal), SK: sourceSk(s.source), entity: 'SourceHealth', ...s })),
    mainTable.put({ PK: healthPk(principal), SK: QUALITY_SK, entity: 'DataQuality', asOf: nowIso, issues: quality }),
  ]);
  return { asOf: nowIso, sources, dataQuality: quality };
}

export async function loadHealth(principal: Principal): Promise<IntegrationHealth | undefined> {
  requireTenantScope(principal);
  const sources = (await Promise.all(HEALTH_SOURCES.map((s) => mainTable.get(healthPk(principal), sourceSk(s)))))
    .filter((i): i is NonNullable<typeof i> => !!i)
    .map((i) => {
      const { PK, SK, entity, ...rest } = i;
      return rest as unknown as SourceHealth;
    });
  const quality = await mainTable.get(healthPk(principal), QUALITY_SK) as unknown as { asOf: string; issues: DataQualityIssue[] } | undefined;
  if (sources.length === 0 || !quality) return undefined;
  return { asOf: quality.asOf, sources, dataQuality: quality.issues };
}

/** One line per source, for the tool and the demo. */
export function describeSource(s: SourceHealth): string {
  if (s.status === 'not-configured') return s.source + ': not configured for this tenant';
  const parts = [s.source + ': ' + s.status.toUpperCase() + (s.stale ? ' (STALE)' : '')];
  if (s.status === 'down') {
    parts.push(s.consecutiveFailures + ' failed poll(s)');
    parts.push(s.lastSuccessAt ? 'last good data ' + s.lastSuccessAt : 'no good data yet');
    if (s.lastError) parts.push('error: ' + s.lastError);
  }
  for (const g of s.gaps) parts.push('gap: ' + g);
  for (const c of s.caveats) parts.push('caveat: ' + c);
  return parts.join(' - ');
}
