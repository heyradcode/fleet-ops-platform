/**
 * ---------------------------------------------------------------------------
 * Querying Splunk: context this platform does not have
 * ---------------------------------------------------------------------------
 * The forwarder sends our conclusions INTO Splunk. This is the other
 * direction, and it exists because Splunk holds things NetPulse structurally
 * cannot know:
 *
 *   change management  who pushed config to what, and when
 *   identity           an admin logging in from somewhere new
 *   firewall / VPN     traffic that stopped, from a vantage point no vendor
 *                      cloud has
 *
 * At 4am the question "did somebody change something just before this broke"
 * is the single most valuable thing to be able to answer, and it is not
 * answerable from any network vendor's API.
 *
 * ---------------------------------------------------------------------------
 * SPLUNK IS NOT AUTOMATICALLY A NEW OBSERVATION PLANE
 * ---------------------------------------------------------------------------
 * This is the same mistake as deriving `plane` from `encoding`, wearing a
 * different hat, and it is very tempting: Splunk is a whole separate system, so
 * surely agreement from Splunk corroborates?
 *
 * No. The plane is about where knowledge ORIGINATED, not which system it
 * reached us through. If the customer's Splunk ingests the Meraki API - and
 * plenty do - then a Splunk row saying a switch is offline is MERAKI's
 * observation with an extra hop. Counting it as independent would let one
 * vendor's opinion corroborate itself through a proxy, which is exactly the
 * failure the whole plane model exists to prevent, and it would be harder to
 * spot because the data genuinely did come from somewhere else.
 *
 * So results from here do NOT become Observations and cannot corroborate
 * anything. They are CONTEXT: shown to a human, given to the agent, never fed
 * to the rules. Promoting a Splunk index to a plane is a deliberate act that
 * requires knowing what feeds that index, and it belongs in configuration
 * beside the tenant's controller list - not in this file.
 */
import { log } from '../../platform/logger.ts';
import { env } from '../../platform/env.ts';
import { now } from '../../platform/clock.ts';
import type { TenantId } from '../../platform/types.ts';

export type SplunkRow = Record<string, string | number>;

export type SearchResult = {
  rows: SplunkRow[];
  /** The SPL that actually ran. Shown to the operator - see the note below. */
  spl: string;
  truncated: boolean;
};

/** Results are for a human to read, not for a rule to consume. Keep it small. */
export const MAX_ROWS = 25;

/**
 * The searches this platform is allowed to run.
 *
 * A FIXED CATALOGUE, NOT A QUERY BUILDER, and this is a security boundary
 * rather than a convenience. The agent chooses a search by NAME and supplies
 * typed parameters; it never composes SPL.
 *
 * Why that matters more here than with SQL: SPL is not just a query language.
 * It has commands that write (`collect`, `outputlookup`), commands that reach
 * the network (`sendemail`), and commands that run scripts. An injected `|` in
 * a freely-composed search is not a data leak, it is code execution inside the
 * customer's SIEM - the one system that is supposed to be the record of what
 * happened. A prompt-injected LLM composing SPL is precisely the scenario the
 * whole tool-authorisation model exists for.
 *
 * So: no interpolation of model output into SPL, ever. Parameters are escaped
 * and quoted, and the catalogue is small enough to read in one sitting.
 */
export type SearchName = 'recent-config-changes' | 'admin-logins' | 'device-mentions';

type SearchSpec = {
  /** What it answers, in the words an operator would use. */
  purpose: string;
  /** The index it reads. Retention and access control both live here. */
  index: string;
  build(params: { device: string; hours: number; tenant: TenantId }): string;
};

const CATALOGUE: Record<SearchName, SearchSpec> = {
  'recent-config-changes': {
    purpose: 'who changed configuration on this device, and when',
    index: 'change',
    build: ({ device, hours, tenant }) =>
      'search index=change tenant=' + quote(tenant) +
      ' object=' + quote(device) +
      ' earliest=-' + String(hours) + 'h' +
      ' | table _time user object change_type result' +
      ' | sort -_time | head ' + String(MAX_ROWS),
  },

  'admin-logins': {
    purpose: 'privileged logins near this device in this window',
    index: 'auth',
    build: ({ device, hours, tenant }) =>
      'search index=auth tenant=' + quote(tenant) +
      ' dest=' + quote(device) + ' action=success user_category=privileged' +
      ' earliest=-' + String(hours) + 'h' +
      ' | table _time user src action' +
      ' | sort -_time | head ' + String(MAX_ROWS),
  },

  'device-mentions': {
    purpose: 'anything at all mentioning this device across the estate indexes',
    index: '*',
    build: ({ device, hours, tenant }) =>
      // Deliberately the LAST resort. A wildcard index search is the most
      // expensive thing you can ask a Splunk cluster to do, and on a busy
      // deployment it is the query that gets an integration's token throttled.
      'search index=* tenant=' + quote(tenant) + ' ' + quote(device) +
      ' earliest=-' + String(hours) + 'h' +
      ' | table _time index sourcetype _raw' +
      ' | sort -_time | head ' + String(MAX_ROWS),
  },
};

/**
 * Quote and escape one parameter.
 *
 * Backslash first, then the quote - reverse the order and you escape the
 * escape you just added. Newlines go too: SPL is line-oriented, and an embedded
 * newline ends the quoted string and starts a fresh command.
 */
function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, ' ');
  return '"' + escaped + '"';
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Running a search, injected.
 *
 * The real thing is NOT one request. Splunk's search API is asynchronous:
 * `POST /services/search/jobs` returns a job id, you poll
 * `/services/search/jobs/{sid}` until `isDone`, then fetch
 * `/services/search/jobs/{sid}/results`. A naive integration polls in a tight
 * loop and gets throttled; a correct one backs off, and gives up rather than
 * holding a Lambda open for a search the customer's cluster has queued behind
 * somebody's month-end report.
 *
 * `/services/search/jobs/export` streams instead and avoids the polling
 * entirely, at the cost of holding the connection. For a handful of rows of
 * context, export is the better shape.
 */
export type SearchTransport = (spl: string) => Promise<SplunkRow[]>;

export const emptyTransport: SearchTransport = () => Promise.resolve([]);

let transport: SearchTransport = emptyTransport;
export function setSearchTransport(t: SearchTransport): void { transport = t; }
export function resetSearchTransport(): void { transport = emptyTransport; }

/** How long we are willing to wait. A NOC question is not a batch report. */
export const SEARCH_TIMEOUT_MS = 8_000;

export function splunkConfigured(): boolean {
  return env('SPLUNK_SEARCH_URL', '') !== '';
}

/**
 * Run one catalogued search.
 *
 * TENANT IS A PARAMETER, NOT A CALLER CONCERN. Every search in the catalogue
 * filters on it, and there is no code path that builds one without it - the
 * same discipline as the DynamoDB partition key. In a real deployment this is
 * belt and braces: the HEC and search tokens are per tenant and Splunk's own
 * role-based index access enforces it a second time, because a search language
 * powerful enough to be useful is powerful enough to be worth two locks.
 */
export async function runSearch(args: {
  name: SearchName;
  tenant: TenantId;
  device: string;
  hours: number;
}): Promise<SearchResult> {
  const spec = CATALOGUE[args.name];
  if (!spec) throw new Error('unknown search ' + args.name);

  // Clamp rather than trust. An agent that asks for 100000 hours is not
  // malicious, it is a model producing a plausible-looking number - and the
  // cost of that lands on the customer's cluster.
  const hours = Math.max(1, Math.min(Math.floor(args.hours) || 1, 168));
  const spl = spec.build({ device: args.device, hours, tenant: args.tenant });

  const started = now();
  try {
    const rows = await transport(spl);
    log.debug('splunk search', { name: args.name, rows: rows.length, ms: now() - started });
    return { rows: rows.slice(0, MAX_ROWS), spl, truncated: rows.length > MAX_ROWS };
  } catch (err) {
    // A Splunk outage must not fail the agent turn. Context is a bonus; the
    // answer has to be possible without it.
    log.warn('splunk search failed, continuing without context', {
      name: args.name, error: err instanceof Error ? err.message : String(err),
    });
    return { rows: [], spl, truncated: false };
  }
}

export function searchCatalogue(): Array<{ name: SearchName; purpose: string; index: string }> {
  return (Object.keys(CATALOGUE) as SearchName[])
    .map((name) => ({ name, purpose: CATALOGUE[name].purpose, index: CATALOGUE[name].index }));
}
