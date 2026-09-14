/**
 * The syslog decoder. ONE decoder, every vendor.
 *
 * This file is the argument for the whole decoder/mapper split. Cisco, Juniper
 * and Aruba all speak syslog, all arrive on the same UDP port and all land in
 * the same S3 prefix. The framing they share; the message content they do not.
 * So the framing is parsed exactly once, here, and what the message MEANS is
 * decided by a mapper that knows the platform.
 *
 * TWO FORMATS, and the older one is a genuine problem.
 *
 *   RFC 5424  <PRI>1 TIMESTAMP HOST APP PROCID MSGID [SD] MSG
 *             Full ISO-8601 timestamp with an offset. Everything we want.
 *   RFC 3164  <PRI>MMM dd hh:mm:ss HOST TAG: MSG
 *             NO YEAR and NO TIMEZONE. Still emitted by a great deal of live
 *             kit, so it cannot simply be rejected.
 *
 * What we do about the 3164 timestamp is deliberate: reconstruct it using the
 * year and zone of the COLLECTOR's arrival time, then let `resolveObservedAt`
 * police the result. That is right whenever the device is roughly in step with
 * us, and when it is not - a device in another timezone, or a log replayed
 * across New Year - the reconstruction lands far enough out that the skew check
 * rejects it and falls back to arrival time. Which is the correct answer. The
 * alternative, trusting a reconstructed timestamp because we built it
 * ourselves, silently files events into windows that closed hours ago.
 *
 * PRI IS DECODED AND THEN IGNORED for severity. It is kept in `fields` because
 * it is useful when working out why a device said something, but the platform's
 * severity comes from `classify.ts`. See the note there.
 *
 * Nothing in here throws. Push feeds carry truncated datagrams as a matter of
 * routine, and one unparseable line must not cost the other forty thousand in
 * the batch.
 */
import type { Decoder, DecodedRecord, RawBatch } from '../wire.ts';

const RFC5424 = /^<(\d{1,3})>(\d)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*([\s\S]*)$/;
const RFC3164 = /^<(\d{1,3})>([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+([\s\S]*)$/;

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Cisco's `%FACILITY-SEVERITY-MNEMONIC:` prefix - the tag that identifies the message. */
const CISCO_MNEMONIC = /^%([A-Z0-9_]+(?:-[A-Z0-9_]+)*-\d-[A-Z0-9_]+):\s*/;

/**
 * A leading sequence number and an embedded second timestamp, which Cisco adds
 * when `service sequence-numbers` and `service timestamps log datetime` are
 * configured - which is to say, on most production kit. Neither is useful to us
 * and both sit between the hostname and the mnemonic, so they get stripped.
 */
const CISCO_PREAMBLE = /^(?:\d+:\s*)?(?:\*?[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+\S+)?:\s*)?/;

/**
 * Pull one line out of whatever the collector wrote.
 *
 * Vector and Fluent Bit both wrap the line in an envelope with their own
 * metadata; a plain UDP forwarder writes the bare string. Accepting both keeps
 * the collector swappable, which matters because the choice of collector is an
 * operational decision that should not reach into the decoder.
 */
function lineOf(record: unknown): { line: string; collectorHost?: string } | undefined {
  if (typeof record === 'string') return { line: record };
  if (record && typeof record === 'object') {
    const obj = record as Record<string, unknown>;
    const line = obj.message ?? obj.line ?? obj.log;
    if (typeof line === 'string') {
      const host = obj.host ?? obj.hostname;
      return { line, collectorHost: typeof host === 'string' ? host : undefined };
    }
  }
  return undefined;
}

/**
 * RFC 5424 structured data: `[junos@2636 ifIndex="528" ifName="ge-0/0/1"]`.
 *
 * Junos puts the fields worth having in here rather than in the free-text
 * message, which is the single best reason to parse SD at all - it turns
 * "scrape the English sentence" into a field lookup.
 */
function parseStructuredData(rest: string): {
  fields: Record<string, string>; sdId?: string; message: string;
} {
  const fields: Record<string, string> = {};
  let sdId: string | undefined;
  let cursor = rest.trimStart();

  // NILVALUE: a bare '-' in the SD position means "no structured data", and
  // Cisco sends it on every line. Leaving it attached is not cosmetic - the
  // message would then begin '- %LINK-3-UPDOWN' and the mnemonic pattern, which
  // is anchored, would never match. Every Cisco record would decode with an
  // empty tag and be silently unclaimed by its own mapper.
  if (cursor === '-') return { fields, message: '' };
  if (cursor.startsWith('- ')) cursor = cursor.slice(2).trimStart();

  while (cursor.startsWith('[')) {
    let end = -1;
    for (let i = 1; i < cursor.length; i++) {
      if (cursor[i] === ']' && cursor[i - 1] !== '\\') { end = i; break; }
    }
    if (end === -1) break;                       // unterminated; treat the rest as message

    const element = cursor.slice(1, end);
    // The SD-ID leads the element and carries the vendor's enterprise number -
    // `junos@2636`. That makes it the most reliable vendor discriminator on the
    // whole syslog path: unlike a hostname it cannot be edited, and unlike the
    // message text it does not change between software releases.
    const id = /^([^\s\]]+)/.exec(element);
    if (id && sdId === undefined) sdId = id[1];

    for (const m of element.matchAll(/([A-Za-z0-9_.@-]+)="((?:[^"\\]|\\.)*)"/g)) {
      fields[m[1]] = m[2].replace(/\\(.)/g, '$1');
    }
    cursor = cursor.slice(end + 1).trimStart();
  }

  return { fields, sdId, message: cursor };
}

/**
 * Rebuild a full timestamp from RFC 3164's month/day/time.
 *
 * Uses the collector's year and treats the device as being on UTC. Both are
 * assumptions; see the file header for why making them - and then letting the
 * skew check catch them - beats refusing to parse.
 */
function reconstruct3164(month: string, day: string, time: string, receivedAt: string): string | undefined {
  const mon = MONTHS[month];
  if (mon === undefined) return undefined;

  const arrived = new Date(receivedAt);
  if (Number.isNaN(arrived.getTime())) return undefined;

  const [hh, mm, ss] = time.split(':').map(Number);
  const stamp = Date.UTC(arrived.getUTCFullYear(), mon, Number(day), hh, mm, ss);

  // A December log arriving in January reconstructs a year into the future.
  // Rolling it back is cheap and removes the one case where the reconstruction
  // is wrong by a whole year rather than by a recoverable amount.
  const rolled = stamp > arrived.getTime() + 86_400_000
    ? Date.UTC(arrived.getUTCFullYear() - 1, mon, Number(day), hh, mm, ss)
    : stamp;

  return new Date(rolled).toISOString();
}

function decodeLine(line: string, batch: RawBatch, collectorHost?: string): DecodedRecord | undefined {
  const rfc5424 = RFC5424.exec(line);
  const rfc3164 = rfc5424 ? undefined : RFC3164.exec(line);
  if (!rfc5424 && !rfc3164) return undefined;

  const fields: Record<string, string | number | boolean> = {};
  let claimedHost: string;
  let claimedTime: string | undefined;
  let body: string;
  let tag = '';
  let pri: number;

  if (rfc5424) {
    pri = Number(rfc5424[1]);
    claimedHost = rfc5424[4];
    claimedTime = rfc5424[3] === '-' ? undefined : rfc5424[3];
    const appName = rfc5424[5];
    const msgId = rfc5424[7];

    const sd = parseStructuredData(rfc5424[8]);
    for (const [k, v] of Object.entries(sd.fields)) fields[k] = v;
    if (sd.sdId) fields.sdId = sd.sdId;
    body = sd.message;

    if (appName !== '-') fields.appName = appName;
    if (rfc5424[6] !== '-') fields.procId = rfc5424[6];
    // Junos and AOS-CX both put the event name in MSGID, where it is exactly
    // the discriminator a mapper wants. Cisco leaves it '-' and puts its
    // mnemonic in the message instead, which the next block picks up.
    if (msgId !== '-') { fields.msgId = msgId; tag = msgId; }
    fields.syslogFormat = 'rfc5424';
  } else {
    const m = rfc3164!;
    pri = Number(m[1]);
    claimedHost = m[5];
    claimedTime = reconstruct3164(m[2], m[3], m[4], batch.receivedAt);
    body = m[6];
    fields.syslogFormat = 'rfc3164';
    // Flagged so that anything reading `deviceTime` downstream can tell a
    // timestamp we were given from one we assembled.
    if (claimedTime) fields.timestampReconstructed = true;
  }

  body = body.replace(CISCO_PREAMBLE, '');

  const mnemonic = CISCO_MNEMONIC.exec(body);
  if (mnemonic) {
    tag = mnemonic[1];
    fields.mnemonic = mnemonic[1];
    body = body.slice(mnemonic[0].length);
  }

  if (!tag) {
    // Last resort: RFC 3164's `TAG:` convention, e.g. `mib2d[1234]:`.
    const bsd = /^([A-Za-z0-9_.-]+)(?:\[\d+\])?:\s*/.exec(body);
    if (bsd) { tag = bsd[1]; body = body.slice(bsd[0].length); }
  }

  fields.syslogFacility = Math.floor(pri / 8);
  fields.syslogSeverity = pri % 8;     // decoded, deliberately not used - see classify.ts

  return {
    encoding: 'syslog',
    receivedAt: batch.receivedAt,
    claimedHost: claimedHost === '-' ? (collectorHost ?? batch.source.address ?? '') : claimedHost,
    claimedTime,
    tag,
    fields,
    raw: line,
  };
}

export const syslogDecoder: Decoder = {
  encoding: 'syslog',

  decode(batch: RawBatch): DecodedRecord[] {
    const out: DecodedRecord[] = [];
    for (const record of batch.records) {
      const extracted = lineOf(record);
      if (!extracted) continue;
      const decoded = decodeLine(extracted.line, batch, extracted.collectorHost);
      if (decoded) out.push(decoded);
    }
    return out;
  },
};
