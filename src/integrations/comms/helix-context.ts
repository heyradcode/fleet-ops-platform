/**
 * ---------------------------------------------------------------------------
 * Helix context on comms incidents: candidate changes, existing tickets
 * ---------------------------------------------------------------------------
 * Two questions an ops lead asks of every incident, answered from Helix:
 *
 *   "Did anyone change anything?"   changes on the same subject that were in
 *                                   progress, or ended shortly before the
 *                                   signal window
 *   "Is it already being worked?"   open tickets at the same site
 *
 * CANDIDATES, NOT CAUSES. A change that ended four minutes before calls went
 * bad is the first thing to check and frequently the answer - and frequently
 * not. Everything this produces is labelled as a candidate, the assistant is
 * told to say so, and nothing here affects whether anything pages.
 *
 * MATCHING GOES THROUGH TENANT TABLES, like the Webex location table: Helix
 * site names -> facility codes, Helix CI names -> SBC FQDNs. A queue incident
 * gets no Helix context, and says so: nothing maps a Genesys queue to a Helix
 * record, and matching on words in a ticket summary would find coincidences
 * as confidently as causes.
 *
 * A HELIX OUTAGE NEVER FAILS THE POLL. Context is optional by definition; the
 * incident is marked "context unavailable" - distinct from "no related
 * changes", because those are different answers at 4am.
 */
import { redactPii } from '../../ai/guardrails.ts';
import type { CommsClient } from './client.ts';
import type { CommsIncident } from './incidents.ts';
import { SIGNAL_WINDOW_MS } from './signals.ts';
import { errorLine, fqdnKey, type CommsTenantConfig } from './types.ts';
import { pullOpenTickets, pullRecentChanges, type HelixChange, type HelixTicket } from './helix.ts';

/** How long before the signal window a finished change still counts. */
export const CHANGE_LOOKBACK_MS = 2 * 60 * 60 * 1000;
/** How far back to ask Helix at all. Wider than the lookback, so in-progress changes are found. */
const FETCH_SINCE_MS = 24 * 60 * 60 * 1000;

export type IncidentContext = {
  status: 'ok' | 'unavailable' | 'no-mapping';
  note?: string;
  changes: Array<{
    id: string;
    summary: string;
    where: string;
    group: string | null;
    /** Minutes between the change ending and the signal window starting. Negative: ended inside it. Null: still running. */
    endedMinutesBefore: number | null;
  }>;
  tickets: Array<{ id: string; summary: string; status: string; group: string | null; submitted: string }>;
};

/** Pure: which of these changes and tickets belong to this incident. */
export function contextFor(
  incident: CommsIncident, changes: HelixChange[], tickets: HelixTicket[], config: CommsTenantConfig,
): IncidentContext {
  const helix = config.helix;
  if (!helix) return { status: 'no-mapping', note: 'Helix is not configured for this tenant.', changes: [], tickets: [] };

  const opened = Date.parse(incident.openedAt);
  const windowStart = opened - SIGNAL_WINDOW_MS;
  const subject = incident.subject;

  let changeMatches: (c: HelixChange) => boolean;
  let ticketMatches: (t: HelixTicket) => boolean;
  if (subject.kind === 'facility') {
    const atFacility = (site: string | null) => !!site && helix.siteFacility[site] === subject.id;
    changeMatches = (c) => atFacility(c.site);
    ticketMatches = (t) => atFacility(t.site);
  } else if (subject.kind === 'trunk') {
    changeMatches = (c) => !!c.ci && !!helix.ciTrunk[c.ci] && fqdnKey(helix.ciTrunk[c.ci]) === fqdnKey(subject.id);
    // Tickets carry no CI here, and the SBC's site is a data centre that
    // every ticket about anything in it would match. No guess.
    ticketMatches = () => false;
  } else {
    return {
      status: 'no-mapping',
      note: 'No Helix mapping exists for Genesys queues, so no changes or tickets are attached.',
      changes: [],
      tickets: [],
    };
  }

  const relevant = changes
    .filter(changeMatches)
    .filter((c) => c.actualStart !== undefined && c.actualStart <= opened)
    .filter((c) => c.actualEnd === undefined || c.actualEnd >= windowStart - CHANGE_LOOKBACK_MS)
    .map((c) => ({
      id: c.id,
      summary: redactPii(c.summary),
      where: [c.site, c.ci].filter(Boolean).join(' / '),
      group: c.group,
      endedMinutesBefore: c.actualEnd === undefined ? null : Math.round((windowStart - c.actualEnd) / 60_000),
    }))
    // Nearest first: the change that ended just before is the one to check first.
    .sort((a, b) => Math.abs(a.endedMinutesBefore ?? 0) - Math.abs(b.endedMinutesBefore ?? 0));

  const open = tickets
    .filter(ticketMatches)
    .map((t) => ({
      id: t.id,
      // Summaries are free text. redactPii takes out addresses and numbers;
      // it does NOT catch a bare name. Only the one-line summary is kept -
      // never the detail field, which is where names tend to be.
      summary: redactPii(t.summary),
      status: t.status,
      group: t.group,
      submitted: new Date(t.submitted).toISOString(),
    }));

  return { status: 'ok', changes: relevant, tickets: open };
}

/**
 * Fetch once, attach to every incident. A Helix failure marks context
 * unavailable and is RETURNED - for the health view - never thrown.
 */
export async function attachHelixContext(
  client: CommsClient, config: CommsTenantConfig, incidents: CommsIncident[], at: number,
): Promise<{ incidents: CommsIncident[]; error?: string }> {
  if (!config.helix || incidents.length === 0) return { incidents };
  let changes: HelixChange[];
  let tickets: HelixTicket[];
  try {
    changes = await pullRecentChanges(client, at - FETCH_SINCE_MS);
    tickets = await pullOpenTickets(client, at - FETCH_SINCE_MS);
  } catch (err) {
    const error = errorLine(err);
    const note = 'Helix unavailable (' + error.slice(0, 80) + ') - related changes and tickets are UNKNOWN, not absent.';
    return {
      incidents: incidents.map((i) => ({ ...i, context: { status: 'unavailable', note, changes: [], tickets: [] } })),
      error,
    };
  }
  return { incidents: incidents.map((i) => ({ ...i, context: contextFor(i, changes, tickets, config) })) };
}

/** One line per candidate change, for the tool, the board and the demo. */
export function describeChange(c: IncidentContext['changes'][number]): string {
  const when = c.endedMinutesBefore === null ? 'still in progress'
    : c.endedMinutesBefore < 0 ? 'ended during the signal window'
      : 'ended ' + c.endedMinutesBefore + ' min before the signal window';
  return c.id + ' "' + c.summary + '" (' + c.where + ', ' + when + ') - a CANDIDATE, not an established cause';
}
