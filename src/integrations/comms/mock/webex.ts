/**
 * ---------------------------------------------------------------------------
 * Webex (Calling + Meetings) - the mock
 * ---------------------------------------------------------------------------
 * Three hosts, as in production:
 *
 *   webexapis.com                    GET /v1/people
 *                                    GET /v1/locations
 *                                    GET /v1/meetings
 *   analytics.webexapis.com          GET /v1/meeting/qualities?meetingId=
 *   analytics-calling.webexapis.com  GET /v1/cdr_feed?startTime=&endTime=
 *
 * Auth is a bearer token from a service app or integration - there is no
 * client-credentials grant to mock. Any `Bearer mock-webex-...` is accepted;
 * `DEMO_WEBEX_TOKEN` in kernel.ts is the one to use.
 *
 * Shapes modelled from the Webex developer reference, not captured from an
 * org. The CDR field set and the units in the meeting-quality arrays are the
 * least well documented parts; check both against a live org.
 *
 * THE TRAPS THIS MOCK KEEPS:
 *
 *   - Pagination is a `Link: <...>; rel="next"` HEADER with an opaque cursor.
 *     The body has no next field at all, so a client that only reads JSON
 *     sees one page and stops - the shorter-estate failure again.
 *   - Webex ids are base64 of `ciscospark://us/PEOPLE/<uuid>`, not uuids.
 *   - The facility is the Webex Calling LOCATION, whose name is whatever the
 *     admin typed. There is no `LC=` code; mapping location -> facility is a
 *     table somebody maintains. `locationId` only appears with
 *     `callingData=true`.
 *   - `/meetings` returns meeting SERIES unless you ask for
 *     `meetingType=meeting`. Quality data exists only for meeting INSTANCES,
 *     so a series id gets you a 404 from the qualities endpoint.
 *   - A CDR becomes visible about five minutes after the call ENDS. Ask for
 *     the last five minutes and you get nothing, correctly - which is why the
 *     watermark on this feed must lag, not merely overlap.
 *
 * WHAT IS PLANTED: meetings in the last forty minutes with a participant at
 * the Houston location carry heavy packet loss and jitter - the same site the
 * Teams mock degrades. Two services, one WAN.
 */
import { seededUuid } from '../../../platform/crypto.ts';
import type { Random } from '../../../platform/random.ts';
import {
  BadRequest, createApp, decodeCursor, encodeCursor, intParam,
  type MockApp, type MockRequest, type MockResponse,
} from './kernel.ts';
import { directory, FACILITIES, streamFor, type Person } from './directory.ts';
import { ACTIVITY_WINDOW_MS, activityAnchor, iso, PLANTED_WINDOW_MS } from './time.ts';
import { now } from '../../../platform/clock.ts';
import { PLANTED as TEAMS_PLANTED } from './teams.ts';

/** How long after a call ends its CDR appears in the feed. */
export const CDR_VISIBILITY_DELAY_MS = 5 * 60 * 1000;

const SITE_URL = 'hhs-mock.webex.example';

function webexId(kind: 'PEOPLE' | 'LOCATION' | 'ORGANIZATION', uuid: string): string {
  return btoa('ciscospark://us/' + kind + '/' + uuid).replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Errors and paging
// ---------------------------------------------------------------------------

function webexError(status: number, _code: string, message: string): MockResponse {
  const text = status === 401
    ? 'The request requires a valid access token set in the Authorization request header.'
    : message;
  return {
    status,
    body: {
      message: text,
      errors: [{ description: text }],
      trackingId: 'MOCK_00000000-0000-0000-0000-000000000000',
    },
  };
}

/** `{ items }` plus a Link header when there is more. Nothing in the body says so. */
function linkPage(req: MockRequest, all: unknown[], defaultMax: number, maxMax: number): MockResponse {
  const max = intParam(req, 'max', defaultMax, 1, maxMax);
  const offset = decodeCursor(req.query.get('cursor'));
  const items = all.slice(offset, offset + max);
  const res: MockResponse = { status: 200, body: { items } };
  if (offset + max < all.length) {
    const q = new URLSearchParams(req.query);
    q.set('cursor', encodeCursor(offset + max));
    q.set('max', String(max));
    res.headers = { Link: '<' + req.base + req.path + '?' + q.toString() + '>; rel="next"' };
  }
  return res;
}

// ---------------------------------------------------------------------------
// People and locations
// ---------------------------------------------------------------------------

type Location = { id: string; name: string; facilityCode: string; city: string; street: string };

let locationsCache: Location[] | undefined;

function locations(): Location[] {
  if (locationsCache) return locationsCache;
  const id = seededUuid(streamFor('webex-locations'));
  // Admin-typed names, deliberately inconsistent: the facility code is in
  // some and not others, which is what a real org looks like.
  const names: Record<string, string> = {
    '0412': 'Austin - Central Office (0412)',
    '0417': 'AUS North Campus',
    '1120': 'HOU-1120 Houston Regional',
    '1455': 'Dallas Regional Office',
    '2031': 'ELP Field 2031',
    '3308': 'Lubbock',
  };
  locationsCache = FACILITIES.map((f) => ({
    id: webexId('LOCATION', id()),
    name: names[f.code],
    facilityCode: f.code,
    city: f.city,
    street: f.street,
  }));
  return locationsCache;
}

function locationOf(p: Person): Location | undefined {
  return locations().find((l) => l.facilityCode === p.facility?.code);
}

function webexPeople(): Person[] {
  return directory().people.filter((p) => p.inWebex);
}

function personRecord(p: Person, callingData: boolean) {
  const d = directory();
  const loc = locationOf(p);
  const record: Record<string, unknown> = {
    id: webexId('PEOPLE', p.ids.webex),
    emails: [p.email],
    phoneNumbers: p.phone ? [{ type: 'work', value: p.phone, primary: true }] : [],
    displayName: p.firstName + ' ' + p.lastName,
    nickName: p.firstName,
    firstName: p.firstName,
    lastName: p.lastName,
    orgId: webexId('ORGANIZATION', d.webexOrgId),
    roles: [],
    licenses: [],
    created: '2024-05-20T14:00:00.000Z',
    lastModified: '2026-07-01T09:00:00.000Z',
    status: 'active',
    invitePending: false,
    loginEnabled: true,
    type: 'person',
  };
  if (callingData) {
    record.extension = p.phone ? p.phone.slice(-4) : undefined;
    // Two people have no facility; Webex puts them nowhere, rather than at a
    // default location, and the connector must report them the same way.
    record.locationId = loc?.id;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Activity: calls and meetings, per anchor
// ---------------------------------------------------------------------------

type Meeting = {
  id: string;
  seriesId: string;
  title: string;
  start: number;
  end: number;
  host: Person;
  participants: Person[];
};

type Activity = { cdrs: Array<{ endedAt: number; row: Record<string, unknown> }>; meetings: Meeting[] };

let cache: { anchor: number; activity: Activity } | undefined;

function activity(): Activity {
  const anchor = activityAnchor();
  if (cache?.anchor !== anchor) cache = { anchor, activity: generate(anchor) };
  return cache.activity;
}

function generate(anchor: number): Activity {
  const rng = streamFor('webex-activity', anchor);
  const id = seededUuid(rng);
  const people = webexPeople();
  const callers = people.filter((p) => p.phone);
  const d = directory();
  const start = anchor - ACTIVITY_WINDOW_MS;

  const cdrs: Activity['cdrs'] = [];
  for (const p of callers) {
    const n = Math.floor(rng() * 5);
    for (let i = 0; i < n; i++) {
      const t0 = start + Math.floor(rng() * ACTIVITY_WINDOW_MS);
      const answered = rng() < 0.9;
      const seconds = answered ? 15 + Math.floor(rng() * 900) : 0;
      const outbound = rng() < 0.5;
      const external = '+1' + String(2100000000 + Math.floor(rng() * 7000000000));
      const loc = locationOf(p);
      const endedAt = t0 + 3000 + seconds * 1000;
      cdrs.push({
        endedAt,
        row: {
          'Start time': iso(t0),
          'Answer time': answered ? iso(t0 + 3000) : null,
          'Release time': iso(endedAt),
          Duration: seconds,
          Answered: answered,
          Direction: outbound ? 'ORIGINATING' : 'TERMINATING',
          'Call type': 'SIP_NATIONAL',
          'Calling number': outbound ? p.phone : external,
          'Called number': outbound ? external : p.phone,
          'Calling line ID': outbound ? p.firstName + ' ' + p.lastName : 'EXTERNAL',
          'Called line ID': outbound ? 'EXTERNAL' : p.firstName + ' ' + p.lastName,
          User: p.email,
          'User type': 'User',
          'User UUID': p.ids.webex,
          Location: loc?.name ?? null,
          'Location UUID': loc ? loc.id : null,
          'Org UUID': d.webexOrgId,
          'Correlation ID': id(),
          'Call ID': 'SSE' + String(Math.floor(rng() * 1e12)) + '@mock.webex.example',
          'Releasing party': rng() < 0.5 ? 'Local' : 'Remote',
          'Call outcome': answered ? 'Success' : 'Failure',
          'Call outcome reason': answered ? 'Normal' : 'NoAnswer',
        },
      });
    }
  }
  cdrs.sort((a, b) => String(a.row['Start time']).localeCompare(String(b.row['Start time'])));

  const meetings: Meeting[] = [];
  const hosts = people.slice(0, 20);
  for (let i = 0; i < 36; i++) {
    const host = hosts[Math.floor(rng() * hosts.length)];
    const t0 = start + Math.floor(rng() * (ACTIVITY_WINDOW_MS - 30 * 60_000));
    // Make sure the planted window has meetings in it, with Houston present.
    const s = i < 4 ? anchor - PLANTED_WINDOW_MS + i * 5 * 60_000 : t0;
    const participants = [host, ...pickSome(people, 2 + Math.floor(rng() * 5), rng)];
    if (i < 4) {
      const houston = people.find((p) => p.facility?.code === TEAMS_PLANTED.degradedFacility);
      if (houston && !participants.includes(houston)) participants.push(houston);
    }
    meetings.push({
      id: id().replace(/-/g, '') + '_I_' + String(100000000 + i),
      seriesId: id().replace(/-/g, ''),
      title: 'Ops sync ' + String(i + 1),
      start: s,
      end: Math.min(anchor, s + (15 + Math.floor(rng() * 45)) * 60_000),
      host,
      participants: [...new Set(participants)],
    });
  }
  meetings.sort((a, b) => a.start - b.start);
  return { cdrs, meetings };
}

function pickSome<T>(items: T[], n: number, rng: Random): T[] {
  const out: T[] = [];
  for (let i = 0; i < n && items.length > 0; i++) out.push(items[Math.floor(rng() * items.length)]);
  return out;
}

function meetingRecord(m: Meeting, instance: boolean) {
  return {
    id: instance ? m.id : m.seriesId,
    meetingSeriesId: m.seriesId,
    title: m.title,
    meetingType: instance ? 'meeting' : 'meetingSeries',
    state: instance ? 'ended' : 'expired',
    timezone: 'America/Chicago',
    start: iso(m.start),
    end: iso(m.end),
    hostUserId: webexId('PEOPLE', m.host.ids.webex),
    hostDisplayName: m.host.firstName + ' ' + m.host.lastName,
    hostEmail: m.host.email,
    siteUrl: SITE_URL,
  };
}

/**
 * Per-participant media quality, sampled each minute. Latency and jitter are
 * milliseconds, packet loss a percentage - VERIFY against a live org; this is
 * the part of the Webex reference with the least detail.
 */
function qualityRecords(m: Meeting): Record<string, unknown>[] {
  const rng = streamFor('webex-quality-' + m.id);
  const planted = m.start >= activityAnchor() - PLANTED_WINDOW_MS;
  return m.participants.map((p) => {
    const degraded = planted && p.facility?.code === TEAMS_PLANTED.degradedFacility;
    const minutes = Math.max(1, Math.round((m.end - m.start) / 60_000));
    const series = (base: number, spread: number) =>
      Array.from({ length: minutes }, () => Math.round((base + rng() * spread) * 10) / 10);
    const media = () => [{
      samplingInterval: 60,
      startTime: iso(m.start),
      endTime: iso(m.end),
      packetLoss: degraded ? series(5, 9) : series(0, 0.6),
      latency: degraded ? series(180, 160) : series(25, 40),
      jitter: degraded ? series(35, 60) : series(2, 8),
      mediaBitRate: series(38, 30),
      transportType: 'UDP',
    }];
    const loc = locationOf(p);
    return {
      meetingInstanceId: m.id,
      webexUserName: p.firstName + ' ' + p.lastName,
      webexUserEmail: p.email,
      joinTime: iso(m.start),
      leaveTime: iso(m.end),
      clientType: 'Webex Desktop',
      clientVersion: '44.8.0.0',
      osType: 'Windows',
      networkType: degraded ? 'wifi' : 'wired',
      // Locations are not on the quality record - only an IP. As with Teams,
      // the site comes from a subnet table the knowledge graph has to own.
      localIP: '10.' + (loc ? Number(loc.facilityCode) % 250 : 0) + '.1.' + String(10 + Math.floor(rng() * 200)),
      serverRegion: 'US Central',
      participantId: p.ids.webex,
      audioIn: media(),
      audioOut: media(),
      videoIn: [],
      videoOut: [],
    };
  });
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export const webexApi: MockApp = createApp('webex', 'api', [
  {
    method: 'GET',
    pattern: '/v1/people',
    handler(req) {
      const email = req.query.get('email')?.toLowerCase();
      const callingData = req.query.get('callingData') === 'true';
      const rows = webexPeople()
        .filter((p) => !email || p.email.toLowerCase() === email)
        .map((p) => personRecord(p, callingData));
      return linkPage(req, rows, 100, 1000);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/locations',
    handler(req) {
      const orgId = webexId('ORGANIZATION', directory().webexOrgId);
      const rows = locations().map((l) => ({
        id: l.id,
        name: l.name,
        orgId,
        timeZone: 'America/Chicago',
        address: { address1: l.street, city: l.city, state: 'TX', country: 'US' },
      }));
      return linkPage(req, rows, 100, 1000);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/meetings',
    handler(req) {
      const instance = req.query.get('meetingType') === 'meeting';
      const from = Date.parse(req.query.get('from') ?? '') || activityAnchor() - ACTIVITY_WINDOW_MS;
      const to = Date.parse(req.query.get('to') ?? '') || activityAnchor();
      const rows = activity().meetings
        .filter((m) => m.start >= from && m.start < to)
        .map((m) => meetingRecord(m, instance));
      return linkPage(req, rows, 10, 100);
    },
  },
], (status, code, message) => webexError(status, code, message));

export const webexAnalytics: MockApp = createApp('webex', 'analytics', [
  {
    method: 'GET',
    pattern: '/v1/meeting/qualities',
    handler(req) {
      const meetingId = req.query.get('meetingId');
      if (!meetingId) throw new BadRequest('meetingId is required');
      const m = activity().meetings.find((x) => x.id === meetingId);
      if (!m) return webexError(404, '', 'Meeting instance not found. A meeting SERIES id has no quality data.');
      return linkPage(req, qualityRecords(m), 10, 1000);
    },
  },
], (status, code, message) => webexError(status, code, message));

export const webexCallingAnalytics: MockApp = createApp('webex', 'analytics-calling', [
  {
    method: 'GET',
    pattern: '/v1/cdr_feed',
    handler(req) {
      const from = Date.parse(req.query.get('startTime') ?? '');
      const to = Date.parse(req.query.get('endTime') ?? '');
      if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
        throw new BadRequest('startTime and endTime are required ISO-8601 instants, startTime < endTime');
      }
      const location = req.query.get('locations');
      const visibleBefore = now() - CDR_VISIBILITY_DELAY_MS;
      const rows = activity().cdrs
        .filter(({ endedAt, row }) => {
          const started = Date.parse(String(row['Start time']));
          return started >= from && started < to && endedAt <= visibleBefore &&
            (!location || row['Location UUID'] === location);
        })
        .map(({ row }) => row);
      return linkPage(req, rows, 500, 500);
    },
  },
], (status, code, message) => webexError(status, code, message));
