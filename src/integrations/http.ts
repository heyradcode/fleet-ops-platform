/**
 * ---------------------------------------------------------------------------
 * The cloud HTTP contract
 * ---------------------------------------------------------------------------
 * Every feed in this platform is now an HTTP API run by a vendor's cloud:
 * Meraki, Mist and Aruba Central, polled on a schedule, plus the webhooks those
 * same clouds push at us. Nothing arrives over UDP, and nothing is decoded from
 * a wire format.
 *
 * WHAT THAT REMOVED, and it is worth being explicit because the shape of this
 * file is the consequence. An earlier cut had a decoder per ENCODING and a
 * mapper per (vendor, platform, encoding), which was the right factoring when
 * the feeds were syslog and SNMP: RFC 5424 framing is identical whoever sent
 * it, so one parser served three vendors and the arithmetic was N + M instead
 * of N x M.
 *
 * Cloud APIs share no framing. Meraki's JSON, Mist's JSON and Central's JSON
 * have nothing in common but the letters. A decoder keyed on `rest-json` would
 * be `JSON.parse` and nothing else, and the mappers behind it would be one per
 * vendor - which is exactly the connector contract next door. So the split is
 * gone, and what is left in its place is this: the things cloud APIs genuinely
 * DO share, which are none of them about payload shape.
 *
 * WHAT THEY SHARE IS MECHANICS, and each vendor does it differently enough to
 * be worth naming:
 *
 *   pagination   cursor in a Link header (Meraki), page/limit (Mist),
 *                offset/limit (Central). Three strategies, one per vendor,
 *                and getting one wrong silently truncates an estate.
 *   watermarks   "only what changed since last time" is OUR problem now. A
 *                push feed just sent us the new thing; a poll has to remember.
 *   auth         a static key, a token, or an OAuth client-credentials grant
 *                that expires mid-run.
 *   rate limits  per-organisation, and low. Meraki is 5 requests/second.
 *
 * None of that existed on the UDP path, and all of it is now on the critical
 * path of every observation the platform sees.
 */
import type { Encoding, TenantId } from '../platform/types.ts';

/**
 * One archived object, as the poller or the webhook receiver wrote it.
 *
 * STILL BATCHED, and still archived before anything interprets it - that part
 * did not change with the transport. What changed is why it matters. On the UDP
 * path the archive protected against a mapping bug losing data we could never
 * ask for again. Here it protects against something sharper: cloud APIs are
 * rate-limited and most of them only retain a rolling window, so a re-fetch to
 * recover from a mapping bug is not merely expensive, it is often impossible.
 *
 * The key carries the same facts as the body - the layout is
 * `raw/tenant=.../vendor=.../encoding=.../dt=.../hh=...` - so a replay after a
 * mapper fix is a prefix scan rather than a full-bucket read.
 */
export type RawBatch = {
  tenantId: TenantId;
  encoding: Encoding;
  /** When WE received these. Trusted, unlike anything inside the payload. */
  receivedAt: string;
  source: {
    /** Which poller or receiver produced it. For chasing a bug to one instance. */
    collector: string;
    /** The endpoint this page came from. Two endpoints on one cloud differ. */
    resource?: string;
  };
  /**
   * One entry per row in the vendor's reply. Deliberately `unknown` - nobody
   * may read it except that vendor's own connector.
   */
  records: unknown[];
};

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * How a vendor says "there is more".
 *
 * Three strategies because three vendors chose three, and the failure mode is
 * identical in all three: stop paginating one page early and you do not get an
 * error, you get a SHORTER ESTATE. Devices simply are not there, the board
 * shows fewer of them than exist, and nothing anywhere reports a problem.
 * That is why this is a named, tested concept rather than a `while` loop
 * written three times.
 */
export type PageCursor =
  /** Meraki: an opaque URL in a `Link: <...>; rel=next` header. */
  | { kind: 'link-header'; next: string }
  /** Mist: page number and size. */
  | { kind: 'page'; page: number; limit: number }
  /** Aruba Central: offset and limit. */
  | { kind: 'offset'; offset: number; limit: number }
  /** No more pages. */
  | { kind: 'done' };

export type HttpPage = {
  /** The rows on this page, vendor-shaped. */
  records: unknown[];
  /** Where the next page is, or `done`. */
  next: PageCursor;
};

/**
 * A hard ceiling on pages per run.
 *
 * Not paranoia: a pagination bug that returns the SAME cursor forever is an
 * infinite loop against a rate-limited API, which means a Lambda that runs for
 * its full fifteen minutes, burns the vendor quota for every other tenant on
 * the account, and gets the integration throttled. Bounded, logged, and
 * surfaced as a partial result - because a partial estate you know about beats
 * a complete one you never finish fetching.
 */
export const MAX_PAGES_PER_RUN = 50;

/**
 * Drain every page of one resource.
 *
 * Takes the fetch as a function so the connector owns the vendor specifics and
 * this owns the loop, the bound and the accounting. `pages` comes back on the
 * result because "we stopped at the ceiling" has to be visible to the caller;
 * a silent truncation here is the exact failure this function exists to make
 * impossible.
 */
export async function drainPages(
  fetchPage: (cursor: PageCursor) => Promise<HttpPage>,
  start: PageCursor,
): Promise<{
  records: unknown[];
  pages: number;
  truncated: boolean;
  /**
   * Where the drain stopped: `done`, or the cursor to resume from. Callers
   * that can resume across runs - Graph's delta sync, whose first listing of
   * a 75,000-user directory is longer than one run's page ceiling - save this
   * and start there next time instead of from page one.
   */
  next: PageCursor;
}> {
  const records: unknown[] = [];
  let cursor = start;
  let pages = 0;

  while (cursor.kind !== 'done' && pages < MAX_PAGES_PER_RUN) {
    const page = await fetchPage(cursor);
    records.push(...page.records);
    pages++;

    // A cursor that has not moved is a vendor bug or ours, and either way the
    // next iteration would fetch the same page again. Stop rather than spin.
    if (sameCursor(cursor, page.next)) break;
    cursor = page.next;
  }

  return { records, pages, truncated: cursor.kind !== 'done' && pages >= MAX_PAGES_PER_RUN, next: cursor };
}

function sameCursor(a: PageCursor, b: PageCursor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'link-header' && b.kind === 'link-header') return a.next === b.next;
  if (a.kind === 'page' && b.kind === 'page') return a.page === b.page;
  if (a.kind === 'offset' && b.kind === 'offset') return a.offset === b.offset;
  return false;
}

// ---------------------------------------------------------------------------
// Watermarks
// ---------------------------------------------------------------------------

/**
 * Where a poller got to last time.
 *
 * A PUSH FEED NEVER NEEDED THIS. Syslog sent us the new line and the question
 * of "what have I already seen" did not arise. Polling makes it ours, and it is
 * the single most consequential piece of state the ingest path now holds: lose
 * it and you either re-process the world every five minutes, or you skip a
 * window and never find out.
 *
 * Kept per (tenant, controller, resource), because one cloud has several
 * endpoints that move at different rates - a device list changes hourly, an
 * alert feed changes constantly.
 */
export type Watermark = {
  tenantId: TenantId;
  controller: string;
  resource: string;
  /** The newest `observedAt` we have successfully PERSISTED, not merely fetched. */
  through: string;
};

/**
 * Deliberately overlapping. See the comment on `sinceFor`.
 */
export const WATERMARK_OVERLAP_MS = 2 * 60 * 1000;

/**
 * The `since` to ask the vendor for.
 *
 * OVERLAPPING BY TWO MINUTES ON PURPOSE, and this is the subtle one. Cloud APIs
 * are eventually consistent: an event timestamped 14:03:59 can become visible
 * to the API at 14:04:30. Ask for `since = last watermark` exactly and that
 * event is never returned to anyone, ever - it fell in the gap between two
 * polls and no error is raised by either.
 *
 * Overlap re-fetches a little and relies on `observationId` being a content
 * hash to make the duplicate writes idempotent. That trade - a few wasted rows
 * against a permanently invisible event - is only available because the id was
 * designed as a hash in the first place.
 */
export function sinceFor(watermark: Watermark | undefined, fallback: Date): Date {
  if (!watermark) return fallback;
  const through = Date.parse(watermark.through);
  if (Number.isNaN(through)) return fallback;
  return new Date(through - WATERMARK_OVERLAP_MS);
}

/**
 * The in-memory watermark store.
 *
 * In production this is a DynamoDB item per (tenant, controller, resource),
 * written in the SAME step that persists the observations - not before. A
 * watermark advanced before the write means a crash between the two loses the
 * window silently, which is the bug this ordering exists to prevent.
 */
const watermarks = new Map<string, Watermark>();

const watermarkKey = (tenantId: string, controller: string, resource: string) =>
  tenantId + '|' + controller + '|' + resource;

export function getWatermark(
  tenantId: string, controller: string, resource: string,
): Watermark | undefined {
  return watermarks.get(watermarkKey(tenantId, controller, resource));
}

export function setWatermark(w: Watermark): void {
  watermarks.set(watermarkKey(w.tenantId, w.controller, w.resource), w);
}

export function resetWatermarks(): void { watermarks.clear(); }
