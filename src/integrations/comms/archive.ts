/**
 * ---------------------------------------------------------------------------
 * The comms archive: each poll's NORMALISED output, in S3 - never people
 * ---------------------------------------------------------------------------
 * A backup of what the Teams, Webex and Genesys polls MEANT, not of what the
 * APIs said: the signals (one number per trunk, facility or queue per
 * window, with its sample size), the alarms and incidents the rules decided,
 * the workforce as COUNTS, and each source's health. Enough to rebuild the
 * comms side of the table, to keep history past the table's lifetime, and to
 * query a year of it with Athena - without a copy of the roster anywhere.
 *
 * NO PEOPLE, twice over:
 *   - by TYPE. `ArchivablePoll` has no field for the roster, the directory
 *     sync or a call record; the poll result's `report` cannot be passed by
 *     mistake. The store keeps counts only (store.ts), and so does this.
 *   - by a TRIPWIRE. Before anything is written, every object is scanned for
 *     an email address or an E.164 phone number; one match refuses the WHOLE
 *     poll's archive, loudly, and the reason names the record type but never
 *     the match - quoting it would write the very thing being refused.
 * A roster that leaked into an evidence sentence by some future change is
 * caught here, not found in a bucket a year later.
 *
 * NEVER FAILS THE POLL, the comms rule: a backup that cannot be written is a
 * logged, reported failure of the backup, and the operational data is
 * already in the table. It is written LAST - a backup of what was decided and
 * stored, never of what was merely fetched.
 *
 * LAYOUT, hive-partitioned for Athena, one JSON Lines object per record type
 * per poll, keyed by the poll's own time - so re-archiving a poll overwrites
 * the same keys (the bucket is versioned; nothing is lost):
 *   comms/<record>/tenant=<t>/dt=YYYY-MM-DD/hh=HH/<YYYYMMDDTHHMMSSZ>.jsonl
 * Every line carries `schema`, `tenantId` and `polledAt`, so a line read on
 * its own still says what it is.
 */
import type { Principal } from '../../platform/types.ts';
import { log } from '../../platform/logger.ts';
import { commsArchiveStore, type ObjectStore } from '../../aws/s3.ts';
import type { CommsSignal } from './signals.ts';
import type { CommsAlarm, CommsIncident } from './incidents.ts';
import type { WorkforceSummary } from './store.ts';
import type { IntegrationHealth } from './health.ts';

/** Bumped when a record's shape changes, so a year of objects stays readable. */
export const ARCHIVE_SCHEMA = 1;

/** What may be archived. Deliberately no roster, no directory, no call record. */
export type ArchivablePoll = {
  signals: CommsSignal[];
  alarms: CommsAlarm[];
  incidents: CommsIncident[];
  resolved: CommsIncident[];
  workforce: WorkforceSummary;
  health: IntegrationHealth;
};

export type ArchiveResult =
  | { status: 'written'; objects: string[]; bytes: number }
  | { status: 'refused'; reason: string }
  | { status: 'failed'; error: string };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /\+\d{8,15}\b/;

/** `2026-09-08T14:30:05.000Z` -> `20260908T143005Z` - sortable, and safe in a key. */
const stamp = (iso: string) => iso.slice(0, 19).replace(/[-:]/g, '') + 'Z';

export async function archiveCommsPoll(
  principal: Principal,
  poll: ArchivablePoll,
  at: number,
  store: ObjectStore = commsArchiveStore,
): Promise<ArchiveResult> {
  const polledAt = new Date(at).toISOString();
  const head = { schema: ARCHIVE_SCHEMA, tenantId: principal.tenantId, polledAt };
  const lines = (rows: object[]) => rows.map((r) => JSON.stringify({ ...head, ...r })).join('\n') + (rows.length ? '\n' : '');

  const records: Record<string, string> = {
    signals: lines(poll.signals),
    alarms: lines(poll.alarms),
    incidents: lines([
      ...poll.incidents.map((i) => ({ state: 'open', ...i })),
      ...poll.resolved.map((i) => ({ state: 'resolved', ...i })),
    ]),
    workforce: lines([poll.workforce]),
    health: lines([poll.health]),
  };

  // The tripwire - before a single byte is written.
  for (const [record, body] of Object.entries(records)) {
    const what = EMAIL.test(body) ? 'an email address' : PHONE.test(body) ? 'a phone number' : undefined;
    if (what) {
      const reason = what + ' in the ' + record + ' record - the archive holds signals and counts, never people. Nothing was written.';
      log.error('comms archive: REFUSED', { tenant: principal.tenantId, polledAt, record });
      return { status: 'refused', reason };
    }
  }

  const partition = 'tenant=' + principal.tenantId + '/dt=' + polledAt.slice(0, 10) + '/hh=' + polledAt.slice(11, 13);
  const file = stamp(polledAt) + '.jsonl';
  try {
    const objects = await Promise.all(Object.entries(records).map(([record, body]) =>
      store.put('comms/' + record + '/' + partition + '/' + file, body, 'application/x-ndjson')));
    const bytes = Object.values(records).reduce((n, b) => n + b.length, 0);
    return { status: 'written', objects: objects.sort(), bytes };
  } catch (err) {
    // Partial writes are harmless: the next archive of this poll overwrites
    // the same keys. The poll itself has already succeeded.
    const error = err instanceof Error ? err.message : String(err);
    log.error('comms archive: FAILED - the backup of this poll is missing', { tenant: principal.tenantId, polledAt, error });
    return { status: 'failed', error };
  }
}
