/**
 * ---------------------------------------------------------------------------
 * BMC Helix ITSM - changes and tickets, read-only
 * ---------------------------------------------------------------------------
 * Helix is CONTEXT, never evidence - the same rule as Splunk. A change record
 * does not become a signal and cannot page anyone; it is attached to an
 * incident as a CANDIDATE explanation (see helix-context.ts). "A change at
 * Houston ended four minutes before its calls went bad" is a correlation, and
 * everything downstream is careful to say so.
 *
 * READ-ONLY by code and, in production, by permission: the integration user
 * should hold read access to these two forms and nothing else. Creating or
 * updating a ticket pages people, and is a separate decision.
 *
 * QUALIFICATIONS ARE BUILT, NEVER CONCATENATED. `q=` is AR System's query
 * language. A value spliced into it unescaped - a site name with a quote in
 * it, or anything that ever came from a vendor payload - rewrites the query.
 * The consequence is smaller than SPL's (this is a read) but it is the same
 * class of bug, so it gets the same treatment: typed conditions, field names
 * checked against an allow-pattern, values escaped by AR's own rule.
 *
 * SELECT THE FIELDS. Without `fields=values(...)` a ticket comes back with the
 * submitter's name and email. This connector never asks for them.
 */
import { drainPages, type HttpPage, type PageCursor } from '../http.ts';
import type { CommsClient } from './client.ts';

export type HelixChange = {
  id: string;
  summary: string;
  status: string;
  site: string | null;
  /** Flattened on the mock; an association form in real Helix - see the mock's header. */
  ci: string | null;
  group: string | null;
  actualStart?: number;
  actualEnd?: number;
};

export type HelixTicket = {
  id: string;
  summary: string;
  status: string;
  site: string | null;
  group: string | null;
  submitted: number;
};

export type Condition = { field: string; op: '=' | '!=' | '<' | '<=' | '>' | '>='; value: string };

const FIELD_NAME = /^[A-Za-z0-9 _:.\-]+$/;

/**
 * `'Field' op "value" AND ...`, escaped. Field names are OURS, so a name that
 * fails the pattern is a bug here and throws; values are escaped the way AR
 * escapes a double quote inside a string - by doubling it.
 */
export function qualification(conds: Condition[]): string {
  return conds.map((c) => {
    if (!FIELD_NAME.test(c.field)) throw new Error('refusing field name in qualification: ' + c.field);
    return "'" + c.field + "' " + c.op + ' "' + c.value.replace(/"/g, '""') + '"';
  }).join(' AND ');
}

/**
 * AR's `2026-09-08T13:35:00.000+0000`. The offset has no colon, which some
 * parsers reject and some misread; normalise it rather than hope. Throws on
 * anything unparseable - a silently-NaN change time would drop that change
 * out of every window comparison without a trace.
 */
export function parseArDate(s: string | null | undefined): number | undefined {
  if (s === null || s === undefined || s === '') return undefined;
  const normalised = s.replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3');
  const t = Date.parse(normalised);
  if (Number.isNaN(t)) throw new Error('unparseable AR timestamp: ' + s);
  return t;
}

/** An AR timestamp for a qualification value. */
export const arTimestamp = (ms: number) => new Date(ms).toISOString().replace('Z', '+0000');

async function fetchEntries(
  client: CommsClient, form: string, conds: Condition[], fields: string[],
): Promise<Array<Record<string, string | null>>> {
  const q = new URLSearchParams({ q: qualification(conds), fields: 'values(' + fields.join(',') + ')', limit: '200' });
  const start = client.endpoints.helixApi + '/api/arsys/v1/entry/' + encodeURIComponent(form) + '?' + q;
  const result = await drainPages(async (cursor: PageCursor): Promise<HttpPage> => {
    if (cursor.kind !== 'link-header') throw new Error('helix cursor must be a link');
    const body = await (await client.request('helix', cursor.next)).json() as {
      entries: Array<{ values: Record<string, string | null> }>;
      _links?: { next?: Array<{ href: string }> };
    };
    const next = body._links?.next?.[0]?.href;
    return { records: body.entries.map((e) => e.values), next: next ? { kind: 'link-header', next } : { kind: 'done' } };
  }, { kind: 'link-header', next: start });
  return result.records as Array<Record<string, string | null>>;
}

// ---------------------------------------------------------------------------
// The client registry - same shape as the Splunk search transport
// ---------------------------------------------------------------------------

/**
 * Where a caller that is NOT the comms poll - the agent's `recentChanges`
 * tool - gets a Helix client for a tenant. A registry, not an import, for the
 * reason every platform boundary here is one: production wires a real client
 * with credentials from Secrets Manager, the demo, board and tests wire the
 * mock, and nothing in between knows which.
 *
 * Unset means "Helix is not configured", and callers must SAY so. An empty
 * list of changes and "we could not ask" are different answers.
 */
export type HelixClientFactory = (tenantId: string) => CommsClient | undefined;
let clientFactory: HelixClientFactory = () => undefined;
export function setHelixClientFactory(f: HelixClientFactory): void { clientFactory = f; }
export function resetHelixClientFactory(): void { clientFactory = () => undefined; }
export function helixClientFor(tenantId: string): CommsClient | undefined { return clientFactory(tenantId); }

/** Changes that STARTED since `since`. Scheduled-but-not-started ones have no actual start and are excluded. */
export async function pullRecentChanges(client: CommsClient, since: number): Promise<HelixChange[]> {
  const rows = await fetchEntries(client, 'CHG:Infrastructure Change',
    [{ field: 'Actual Start Date', op: '>=', value: arTimestamp(since) }],
    ['Infrastructure Change ID', 'Description', 'Change Request Status', 'Site', 'CI Name',
      'Support Group Name', 'Actual Start Date', 'Actual End Date']);
  return rows.map((r) => ({
    id: r['Infrastructure Change ID'] ?? '',
    summary: r['Description'] ?? '',
    status: r['Change Request Status'] ?? '',
    site: r['Site'],
    ci: r['CI Name'],
    group: r['Support Group Name'],
    actualStart: parseArDate(r['Actual Start Date']),
    actualEnd: parseArDate(r['Actual End Date']),
  }));
}

/**
 * Tickets submitted since `since` that are still open.
 *
 * Open is "not Resolved, Closed or Cancelled", written as three `!=`. AR's
 * Status is an enumeration and a `<` on it compares the enum's INTEGER, which
 * works until someone adds a status - so the explicit form is used.
 */
export async function pullOpenTickets(client: CommsClient, since: number): Promise<HelixTicket[]> {
  const rows = await fetchEntries(client, 'HPD:Help Desk', [
    { field: 'Submit Date', op: '>=', value: arTimestamp(since) },
    { field: 'Status', op: '!=', value: 'Resolved' },
    { field: 'Status', op: '!=', value: 'Closed' },
    { field: 'Status', op: '!=', value: 'Cancelled' },
  ], ['Incident Number', 'Description', 'Status', 'Site', 'Assigned Group', 'Submit Date']);
  return rows.map((r) => ({
    id: r['Incident Number'] ?? '',
    summary: r['Description'] ?? '',
    status: r['Status'] ?? '',
    site: r['Site'],
    group: r['Assigned Group'],
    submitted: parseArDate(r['Submit Date']) ?? 0,
  }));
}
