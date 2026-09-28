/**
 * ---------------------------------------------------------------------------
 * The Executive Ops Daily Brief
 * ---------------------------------------------------------------------------
 * The deck's "automatic health summary from all sources", for someone who
 * will read it once, on a phone, before their first meeting. That reader
 * changes the rules:
 *
 *   PLAIN WORDS. "Phone calls through trunk SBC2 are failing", not
 *   trunk-call-failure on an FQDN; "Houston Regional", not LC=1120.
 *
 *   IMPACT IN PEOPLE AND CALLS, not ratios - "up to 42 people and 16 desk
 *   phones", "28 callers waiting".
 *
 *   ONE STATUS FIRST, with its reason: red, amber or green.
 *
 *   SAY HOW MUCH TO TRUST IT. A brief built while Genesys was not answering
 *   says so, next to the status - a calm brief over missing data is the worst
 *   thing this could produce.
 *
 * THE NUMBERS NEVER COME FROM A MODEL. Everything here is computed from the
 * stored incidents, figures, health and counts, and the prose is a template
 * over them. A model may one day rephrase it; it may not supply a figure, and
 * the structured `Brief` is what an output guardrail would check it against.
 *
 * DELIVERY is not built here. In production an EventBridge Scheduler rule
 * (cron 0 7 ? * MON-FRI *, America/Chicago) invokes a Lambda that builds this
 * per tenant and sends `renderBrief(b, 'markdown')` through SES or a Teams
 * webhook. Sending mail to executives is an outward-facing action, and wiring
 * it is a decision for the customer, not a default.
 */
import type { Incident, Principal, Severity } from '../platform/types.ts';
import { openIncidents } from '../platform/repository.ts';
import { allSites } from '../geo/device-repository.ts';
import { commsConfigFor } from '../integrations/comms/config.ts';
import {
  commsAlarms, commsIncidents, commsPhones, commsResolvedIncidents, commsWorkforce, requireTenantScope,
} from '../integrations/comms/store.ts';
import { loadHealth } from '../integrations/comms/health.ts';
import type { CommsIncident } from '../integrations/comms/incidents.ts';
import { changesAroundDevice } from '../integrations/comms/helix-network.ts';
import { COMMS_SOURCES } from '../integrations/comms/types.ts';
import { latestAnomalies, type CommsAnomaly } from '../integrations/comms/anomalies.ts';
import type { CandidateCauses } from '../graph/correlate.ts';

export type BriefStatus = 'red' | 'amber' | 'green';

export type BriefItem = {
  id: string;
  area: 'voice' | 'contact centre' | 'network';
  severity: Severity;
  title: string;
  /** "open 2h 10m", or for resolved items "lasted 45m". */
  when: string;
  impact: string;
  /** Recovery progress, reopen history, or why it could not be re-checked. */
  status?: string;
  where?: string;
  /** A Helix change worth checking - always a candidate. */
  candidate?: string;
  /** The knowledge graph's top candidate on the building's own network - always a candidate. */
  networkCandidate?: string;
  /** Already on the service desk's radar. */
  ticket?: string;
  /** What this subject normally looks like at this hour of the week, when there is history. */
  normally?: string;
};

export type Brief = {
  tenantId: string;
  generatedAt: string;
  period: { from: string; to: string };
  status: BriefStatus;
  headline: string;
  open: BriefItem[];
  resolved: BriefItem[];
  watch: string[];
  /**
   * Unusual for the subject and hour of week, with NO open incident: the
   * proactive list. Never alarms - "worth a look before it becomes one".
   */
  unusual: string[];
  confidence: { complete: boolean; notes: string[]; fixes: string[] };
  estate: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 5) return 'under 5 minutes';
  const h = Math.floor(m / 60);
  return h === 0 ? m + ' min' : h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

const pct = (r: number) => Math.round(r * 100) + '%';

// ---------------------------------------------------------------------------
// Comms incidents in plain words
// ---------------------------------------------------------------------------

/**
 * `peopleAt` is passed in, not read from module state: a module-level
 * "current tenant's counts" is how one tenant's numbers end up in another's
 * brief the first time two are built concurrently.
 */
function commsItem(i: CommsIncident, at: number, peopleAt: (code: string) => string): BriefItem {
  const cfg = commsConfigFor(i.tenantId);
  const facilityName = (code: string) => (cfg?.facilityNames?.[code] ?? 'facility') + ' (LC=' + code + ')';

  let area: BriefItem['area'] = 'voice';
  let title: string;
  let impact: string;

  if (i.subject.kind === 'trunk') {
    const label = i.subject.id.startsWith('bandwidth-peer:')
      ? i.subject.name
      : 'trunk ' + i.subject.id.split('.')[0].toUpperCase();
    title = 'Phone calls through ' + label + ' are failing';
    const parts = i.figures.filter((f) => f.kind === 'trunk-call-failure').map((f) =>
      (f.source === 'bandwidth' ? 'carrier' : 'Teams') + ' ' + Math.round(f.value * f.sampleSize) + ' of ' + f.sampleSize);
    const worst = Math.max(0, ...i.figures.filter((f) => f.kind === 'trunk-call-failure').map((f) => f.value));
    // "UP TO": Teams and the carrier count different populations of calls
    // (and may overlap), so neither rate is THE rate - the worst is the
    // honest ceiling, with both shown.
    impact = 'up to ' + pct(worst) + ' of recent calls failing' + (parts.length ? ' (' + parts.join('; ') + ')' : '');
  } else if (i.subject.kind === 'facility') {
    const wan = i.kinds.some((k) => k === 'wan-latency' || k === 'wan-drop-rate');
    const media = i.kinds.includes('facility-media-degradation');
    const place = i.subject.id.startsWith('starlink-terminal:') ? i.subject.name : facilityName(i.subject.id);
    title = wan && media ? 'Poor call quality and a degraded satellite link at ' + place
      : wan ? 'Satellite internet link degraded at ' + place
        : 'Poor call quality at ' + place;
    const drop = i.figures.find((f) => f.kind === 'wan-drop-rate');
    const latency = i.figures.find((f) => f.kind === 'wan-latency');
    const link = [drop ? pct(drop.value) + ' of packets lost' : '', latency ? latency.value + ' ms delay' : ''].filter(Boolean).join(', ');
    impact = (link ? link + '; ' : '') + peopleAt(i.subject.id);
  } else {
    area = 'contact centre';
    title = 'Callers waiting too long in the "' + i.subject.name + '" queue';
    const waiting = i.figures.find((f) => f.kind === 'queue-backlog');
    const abandon = i.figures.find((f) => f.kind === 'queue-abandonment');
    impact = [
      waiting ? waiting.value + ' callers waiting' : '',
      abandon ? pct(abandon.value) + ' of callers hung up (' + Math.round(abandon.value * abandon.sampleSize) + ' of ' + abandon.sampleSize + ')' : '',
    ].filter(Boolean).join('; ') || 'see evidence';
  }

  const status = [
    i.reopenCount ? 'came back ' + i.reopenCount + 'x after resolving' : '',
    // A reopen note only restates reopenCount; say it once.
    i.lifecycleNote && !i.lifecycleNote.startsWith('reopened') ? plainLifecycle(i.lifecycleNote) : '',
  ].filter(Boolean).join('; ');

  const change = i.context?.status === 'ok' ? i.context.changes[0] : undefined;
  const ticket = i.context?.status === 'ok' ? i.context.tickets[0] : undefined;

  return {
    id: i.incidentId, area, severity: i.severity, title,
    when: 'open ' + duration(at - Date.parse(i.openedAt)),
    impact,
    status: status || undefined,
    where: i.localisation.length ? i.localisation.join(' ') : undefined,
    candidate: change
      ? 'Recent change under review: ' + change.id + ' "' + change.summary + '"' +
        (change.endedMinutesBefore === null ? ' (still in progress)' : ' (ended ' + change.endedMinutesBefore + ' min before)')
      : undefined,
    ticket: ticket ? 'Already with the service desk: ' + ticket.id + ' (' + (ticket.group ?? 'unassigned') + ')' : undefined,
  };
}

/**
 * The top network candidate, in words for someone who does not read device
 * names for a living: what, where in the building, and whether it paged -
 * "reported by the device alone" is the plain way to say held back.
 */
function networkCandidateFor(c: CandidateCauses | undefined): string | undefined {
  if (c?.status !== 'found') return undefined;
  const top = c.causes[0];
  return 'On the building\'s own network: ' + top.what.toLowerCase() + ' on its ' + top.role.replace(/-/g, ' ') +
    ' (' + top.device + ')' + (top.paged ? '' : ', reported by the device alone');
}

function plainLifecycle(note: string): string {
  const m = /measured healthy (\d+)\/(\d+)/.exec(note);
  if (m) return 'recovering - healthy for ' + m[1] + ' of ' + m[2] + ' checks';
  if (note.startsWith('not re-verified')) return 'could not be re-checked (' + note.replace(/^not re-verified: /, '') + ')';
  if (note.includes('still firing')) return 'still happening';
  return note;
}

function normalText(a: CommsAnomaly): string {
  const fmt = (v: number) => (a.unit === 'ratio' ? Math.round(v * 1000) / 10 + '%'
    : String(Math.round(v * 10) / 10) + (a.unit === 'ms' ? ' ms' : ''));
  return fmt(a.normal.mean) + ' (±' + fmt(a.normal.std) + ')';
}

// ---------------------------------------------------------------------------
// Network incidents
// ---------------------------------------------------------------------------

async function networkItem(principal: Principal, n: Incident, at: number): Promise<BriefItem> {
  const site = allSites(principal).find((s) => s.siteId === n.siteId)?.name ?? n.siteId;
  const root = n.rootCauseDeviceId;
  const rootName = root ? root.replace(/^dev-/, '') : undefined;
  let candidate: string | undefined;
  if (root) {
    const r = await changesAroundDevice(principal, root, at);
    const c = r.status === 'ok' ? r.changes[0] : undefined;
    if (c) {
      candidate = 'Recent change under review: ' + c.id + ' "' + c.summary + '"' +
        (c.hops === 0 ? ' on the failed device' : ' ' + c.hops + ' hop(s) upstream') +
        (c.endedMinutesBefore === null ? '' : ', ended ' + c.endedMinutesBefore + ' min ago');
    }
  }
  return {
    id: n.incidentId, area: 'network', severity: n.severity,
    title: 'Network problem at ' + site + (rootName ? ': ' + rootName + ' is the likely cause' : ''),
    when: 'open ' + duration(at - Date.parse(n.openedAt)),
    impact: n.deviceIds.length + ' network device' + (n.deviceIds.length === 1 ? '' : 's') + ' affected',
    candidate,
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildDailyBrief(
  principal: Principal, at: number,
  opts: {
    /**
     * The network incidents to include. Defaults to the repository's open
     * ones - what production reads. The board passes the incidents it is
     * showing, so the brief and the board cannot disagree.
     */
    networkIncidents?: Incident[];
    /**
     * The knowledge graph's candidate causes, per comms incident id - the
     * SAME ones the board shows, computed by the caller (graph/correlate.ts).
     * Absent: the brief names no network candidate, rather than guessing.
     */
    causes?: Record<string, CandidateCauses>;
  } = {},
): Promise<Brief> {
  requireTenantScope(principal);
  const from = at - DAY_MS;
  // Every read up front, once, and in parallel. The open incidents were read
  // three times when reads were free; against a real table that is three round
  // trips, and three reads a poll can land between - a brief that counted an
  // incident in one section and not the next.
  const [workforce, phones, health, latestAnomalySet, openComms, resolvedComms, alarms, networkStored] = await Promise.all([
    commsWorkforce(principal),
    commsPhones(principal),
    loadHealth(principal),
    latestAnomalies(principal),
    commsIncidents(principal),
    commsResolvedIncidents(principal, 50),
    commsAlarms(principal),
    opts.networkIncidents ?? openIncidents(principal),
  ]);

  const peopleAt = (code: string) => {
    const people = workforce?.byFacility.find((f) => f.code === code)?.people;
    const desk = phones?.byFacility.find((f) => f.code === code)?.count;
    const parts = [
      people !== undefined ? 'up to ' + people + ' people who make calls there' : '',
      desk !== undefined ? desk + ' desk phones' : '',
    ].filter(Boolean);
    return parts.length ? parts.join(', and ') : 'size not known';
  };

  const anomalies = latestAnomalySet?.anomalies ?? [];
  const subjectKey = (s: { kind: string; id: string }) => s.kind + ':' + s.id;
  // "Normally X" beside an incident: its worst NON-volume anomaly - the rate
  // or count the incident is about, set against this hour's baseline.
  const normallyFor = (i: CommsIncident): string | undefined => {
    const a = anomalies.find((x) => subjectKey(x.subject) === subjectKey(i.subject) && !x.metric.endsWith(':volume'));
    return a ? 'Normally ' + normalText(a) + ' for ' + a.when + ' (' + a.normal.samples + ' weeks of history)' : undefined;
  };
  const commsOpen = openComms.map((i) => ({
    ...commsItem(i, at, peopleAt), normally: normallyFor(i), networkCandidate: networkCandidateFor(opts.causes?.[i.incidentId]),
  }));
  const openSubjects = new Set(openComms.map((i) => subjectKey(i.subject)));
  const unusual = anomalies
    .filter((a) => !openSubjects.has(subjectKey(a.subject)))
    .map((a) => a.explanation.charAt(0).toUpperCase() + a.explanation.slice(1));
  const network = networkStored.filter((n) => n.status !== 'resolved');
  const networkOpen = await Promise.all(network.map((n) => networkItem(principal, n, at)));
  const open = [...commsOpen, ...networkOpen]
    .sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.title.localeCompare(b.title));

  const resolved = resolvedComms
    .filter((i) => i.resolvedAt && Date.parse(i.resolvedAt) >= from)
    .map((i) => ({
      ...commsItem(i, at, peopleAt),
      when: 'lasted ' + duration(Date.parse(i.resolvedAt!) - Date.parse(i.openedAt)) + ', resolved ' + i.resolvedAt!.slice(11, 16) + 'Z',
      status: undefined,
    }));

  // Held back in the LATEST poll only - older polls' alarms are history.
  const latest = alarms.reduce((m, a) => (a.raisedAt > m ? a.raisedAt : m), '');
  const watch = [
    ...alarms.filter((a) => a.raisedAt === latest && !a.corroborated)
      .map((a) => a.subject.name + ': ' + a.kind.replace(/-/g, ' ') + ' reported but not confirmed - ' + a.heldBack),
    ...openComms.filter((i) => i.reopenCount > 0)
      .map((i) => i.subject.name + ' has come back ' + i.reopenCount + 'x after resolving - flapping'),
  ];

  const notes: string[] = [];
  for (const s of health?.sources ?? []) {
    if (s.status === 'down') {
      notes.push(s.source + ' is not responding' + (s.stale ? ' and its data is STALE' : '') +
        (s.lastSuccessAt ? ' (last good data ' + s.lastSuccessAt.slice(11, 16) + 'Z)' : ' (no good data yet)'));
    } else if (s.status === 'degraded') {
      notes.push(s.source + ' answered with a gap: ' + s.gaps.join('; '));
    }
  }
  if (!health) notes.push('No comms poll has recorded source health - this brief covers what the store holds.');
  const fixes = (health?.dataQuality ?? []).slice(0, 3).map((q) => q.detail + ' -> ' + q.action);

  const estate: string[] = [];
  if (workforce) {
    for (const src of COMMS_SOURCES) {
      const p = workforce.byPlatform[src];
      if (!p) continue;
      estate.push(src + ': ' + p.people + ' people (' +
        Object.entries(p.byAgency).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + ' ' + v).join(', ') +
        (Object.values(p.contractorsByDomain).reduce((x, y) => x + y, 0) ? ', contractors ' +
          Object.values(p.contractorsByDomain).reduce((x, y) => x + y, 0) : '') + ')');
    }
  }
  if (phones) {
    estate.push('Cisco desk phones: ' + phones.total + ' (' +
      Object.entries(phones.byAgency).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + ' ' + v).join(', ') + ')');
  }

  const critical = open.filter((o) => o.severity === 'critical');
  const complete = notes.length === 0;
  const status: BriefStatus = critical.length > 0 ? 'red'
    : open.length > 0 || !complete ? 'amber' : 'green';
  const headline = status === 'red'
    ? critical.length + ' critical problem' + (critical.length === 1 ? '' : 's') + ' open: ' +
      critical.map((c) => c.title.charAt(0).toLowerCase() + c.title.slice(1)).join('; ')
    : status === 'amber'
      ? (open.length ? open.length + ' problem(s) open, none critical' : 'No open problems') +
        (complete ? '' : ' - but some data is missing, see "How much to trust this"')
      : 'No open problems, and every feed is reporting';

  return {
    tenantId: principal.tenantId,
    generatedAt: new Date(at).toISOString(),
    period: { from: new Date(from).toISOString(), to: new Date(at).toISOString() },
    status, headline, open, resolved, watch, unusual,
    confidence: { complete, notes, fixes },
    estate,
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Text for the terminal and the assistant; Markdown for mail and Teams. Same content, one source. */
export function renderBrief(b: Brief, format: 'text' | 'markdown'): string {
  const md = format === 'markdown';
  const h = (s: string) => (md ? '## ' + s : s.toUpperCase());
  const li = (s: string) => (md ? '- ' + s : '  - ' + s);
  const sub = (s: string) => (md ? '  - ' + s : '      ' + s);
  const lines: string[] = [];

  lines.push((md ? '# ' : '') + 'Daily operations brief - ' + b.generatedAt.slice(0, 10));
  lines.push((md ? '**' : '') + b.status.toUpperCase() + (md ? '**' : '') + ' - ' + b.headline);
  if (!b.confidence.complete) lines.push((md ? '_' : '') + 'Built on incomplete data - see the last section.' + (md ? '_' : ''));

  const item = (i: BriefItem) => {
    lines.push(li((md ? '**' : '') + i.title + (md ? '**' : '') + ' - ' + i.when));
    lines.push(sub('Impact: ' + i.impact));
    if (i.where) lines.push(sub('Where: ' + i.where));
    if (i.status) lines.push(sub('Status: ' + i.status));
    if (i.candidate) lines.push(sub(i.candidate + ' - a candidate, not a confirmed cause'));
    if (i.networkCandidate) lines.push(sub(i.networkCandidate + ' - a candidate, not a confirmed cause'));
    if (i.ticket) lines.push(sub(i.ticket));
    if (i.normally) lines.push(sub(i.normally));
  };

  lines.push('', h('Open now'));
  if (b.open.length === 0) lines.push(li('Nothing open.'));
  b.open.forEach(item);

  lines.push('', h('Resolved in the last 24 hours'));
  if (b.resolved.length === 0) lines.push(li('Nothing resolved.'));
  for (const r of b.resolved) lines.push(li(r.title + ' - ' + r.when));

  if (b.unusual.length > 0) {
    lines.push('', h('Unusual, not yet at alarm level'));
    b.unusual.forEach((u) => lines.push(li(u)));
  }

  if (b.watch.length > 0) {
    lines.push('', h('Watching'));
    b.watch.forEach((w) => lines.push(li(w)));
  }

  lines.push('', h('How much to trust this'));
  if (b.confidence.complete) lines.push(li('Every feed answered on the latest poll.'));
  b.confidence.notes.forEach((n) => lines.push(li(n)));
  if (b.confidence.fixes.length) {
    lines.push(li('Data fixes that would sharpen it:'));
    b.confidence.fixes.forEach((f) => lines.push(sub(f)));
  }

  if (b.estate.length) {
    lines.push('', h('Estate'));
    b.estate.forEach((e) => lines.push(li(e)));
  }
  return lines.join('\n');
}
