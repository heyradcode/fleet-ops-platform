/**
 * ---------------------------------------------------------------------------
 * Genesys Cloud (contact centre) - the mock
 * ---------------------------------------------------------------------------
 * Two hosts, on the US-Gov region because that is where this customer is:
 *
 *   login.use2.us-gov-pure.cloud  POST /oauth/token        (client credentials)
 *   api.use2.us-gov-pure.cloud    GET  /api/v2/users
 *                                 GET  /api/v2/users/{userId}
 *                                 GET  /api/v2/authorization/divisions
 *                                 GET  /api/v2/routing/queues
 *                                 GET  /api/v2/routing/queues/{queueId}/members
 *                                 POST /api/v2/analytics/queues/observations/query
 *                                 POST /api/v2/analytics/conversations/aggregates/query
 *
 * Shapes modelled from the Genesys Cloud Platform API reference, and the user
 * record from the field names in the customer's sample response - its SHAPE,
 * not its contents. Nothing in the sample is reproduced here.
 *
 * THE TRAPS THIS MOCK KEEPS:
 *
 *   - Pagination is ONE-indexed `pageNumber` with `pageSize` capped at 100.
 *     Ask for 500 and you get a 400, not 100 rows.
 *   - `nextUri` is RELATIVE (`/api/v2/users?pageSize=100&pageNumber=2`). A
 *     client that fetches it as-is fetches from its own origin.
 *   - `/users` returns ACTIVE users unless you pass `state=any`, so a
 *     "how many agents does each agency have" count and a "who has ever
 *     handled a call" join disagree until somebody notices.
 *   - The contact centre is mostly contractors, on their own domains. The
 *     agency split by email domain has a third bucket, and one agency address
 *     is upper-cased.
 *   - Analytics durations are MILLISECONDS, summed. An average is sum / count,
 *     and a queue with no answered calls has no `tAnswered` entry at all -
 *     not a zero.
 *
 * WHAT IS PLANTED: for the last forty minutes the `Eligibility - English`
 * queue is swamped - offered volume doubles, waits run to many minutes, and
 * roughly two callers in five abandon. The observation query shows the
 * backlog right now; the aggregates query shows how it built up.
 */
import { seededUuid } from '../../../platform/crypto.ts';
import {
  BadRequest, createApp, DEMO_CLIENT, intParam, issueToken, jsonBody,
  type MockApp, type MockRequest, type MockResponse,
} from './kernel.ts';
import { directory, streamFor, type Person } from './directory.ts';
import { ACTIVITY_WINDOW_MS, activityAnchor, activityKey, iso, PLANTED_WINDOW_MS, plantedActive } from './time.ts';

export const GENESYS_TOKEN_TTL_S = 86_399;

// ---------------------------------------------------------------------------
// Reference data: divisions, queues, memberships
// ---------------------------------------------------------------------------

type Division = { id: string; name: string };
type Queue = { id: string; name: string; divisionId: string; memberKeys: string[] };

type Reference = { divisions: Division[]; queues: Queue[] };

const QUEUE_DEFS: Array<{ name: string; division: string }> = [
  { name: 'Eligibility - English', division: 'Eligibility Services' },
  { name: 'Eligibility - Spanish', division: 'Eligibility Services' },
  { name: 'Child Abuse Intake', division: 'Protective Intake' },
  { name: 'Provider Enrollment', division: 'Provider Relations' },
  { name: 'IT Service Desk', division: 'IT Service Desk' },
  { name: 'General Inquiries', division: 'Home' },
];

export const PLANTED_QUEUE = 'Eligibility - English';
/**
 * The SUBTLE plant: twice its normal call volume for the hour, with normal
 * abandonment. No rule watches volume at all, so nothing fires; only a
 * baseline notices. It exists to prove the anomaly engine is proactive
 * rather than a second copy of the thresholds.
 *
 * Why volume and not a sub-threshold abandonment rate: that was tried first.
 * At ~26 calls a half hour, "11% abandoning" realised as 2 calls - within a
 * standard deviation of a normal 3-5%, and the engine correctly refused to
 * call it unusual. Rates over small samples are noisy; a volume doubling is
 * not.
 */
export const SUBTLE_QUEUE = 'Eligibility - Spanish';

let reference: Reference | undefined;

function ref(): Reference {
  if (reference) return reference;
  const rng = streamFor('genesys-reference');
  const id = seededUuid(rng);
  // `Home` is the division every Genesys org starts with; the rest are the
  // customer's. Divisions are Genesys's own access boundary, and they do NOT
  // line up with agencies - one division can hold several agencies' staff.
  const names = ['Home', ...new Set(QUEUE_DEFS.map((q) => q.division).filter((n) => n !== 'Home'))];
  const divisions = names.map((name) => ({ id: id(), name }));
  const agents = genesysPeople();

  const queues = QUEUE_DEFS.map((def) => {
    const members = agents.filter(() => rng() < 0.35).map((p) => p.key);
    return {
      id: id(),
      name: def.name,
      divisionId: divisions.find((d) => d.name === def.division)!.id,
      memberKeys: members,
    };
  });
  // Every agent is in at least one queue, or the staffing numbers lie.
  for (const [i, p] of agents.entries()) {
    if (!queues.some((q) => q.memberKeys.includes(p.key))) queues[i % queues.length].memberKeys.push(p.key);
  }
  reference = { divisions, queues };
  return reference;
}

function genesysPeople(): Person[] {
  return directory().people.filter((p) => p.inGenesys);
}

function divisionOf(p: Person): Division {
  const { divisions, queues } = ref();
  const q = queues.find((x) => x.memberKeys.includes(p.key));
  return divisions.find((d) => d.id === q?.divisionId) ?? divisions[0];
}

// ---------------------------------------------------------------------------
// login.use2.us-gov-pure.cloud
// ---------------------------------------------------------------------------

function oauthError(status: number, error: string, description: string): MockResponse {
  return { status, body: { error, description, error_description: description } };
}

export const genesysLogin: MockApp = createApp('genesys', 'login', [
  {
    method: 'POST',
    pattern: '/oauth/token',
    public: true,
    handler(req) {
      // Client id and secret go in a BASIC header, not the form body - the
      // opposite of Entra's convention, and the first thing a connector
      // copied from the Graph one gets wrong.
      const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
      let pair = '';
      try { pair = basic ? atob(basic[1]) : ''; } catch { pair = ''; }
      if (pair !== DEMO_CLIENT.clientId + ':' + DEMO_CLIENT.clientSecret) {
        return oauthError(401, 'invalid_client', 'client id or secret is invalid');
      }
      if (new URLSearchParams(req.body).get('grant_type') !== 'client_credentials') {
        return oauthError(400, 'unsupported_grant_type', 'only client_credentials is modelled');
      }
      return {
        status: 200,
        body: {
          access_token: issueToken('genesys', GENESYS_TOKEN_TTL_S),
          token_type: 'bearer',
          expires_in: GENESYS_TOKEN_TTL_S,
        },
      };
    },
  },
], (status, code, message) => oauthError(status, code, message));

// ---------------------------------------------------------------------------
// api.use2.us-gov-pure.cloud
// ---------------------------------------------------------------------------

function genesysError(status: number, _code: string, message: string): MockResponse {
  const code = status === 401 ? 'bad.credentials'
    : status === 429 ? 'too.many.requests'
      : status === 400 ? 'bad.request'
        : status === 404 ? 'not.found'
          : 'internal.server.error';
  return {
    status,
    body: {
      message, code, status,
      messageParams: {},
      contextId: '00000000-0000-0000-0000-000000000000',
      details: [],
      errors: [],
    },
  };
}

/** The entity-listing envelope every Genesys collection uses. */
function entityListing(req: MockRequest, all: unknown[], extraQuery: Record<string, string> = {}): MockResponse {
  const pageSize = intParam(req, 'pageSize', 25, 1, 100);
  const pageNumber = intParam(req, 'pageNumber', 1, 1, 100_000);
  const total = all.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const uri = (n: number) => {
    const q = new URLSearchParams({ pageSize: String(pageSize), pageNumber: String(n), ...extraQuery });
    return req.path + '?' + q.toString();   // RELATIVE, as the real API returns it
  };
  const body: Record<string, unknown> = {
    entities: all.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
    pageSize, pageNumber, total,
    firstUri: uri(1),
    selfUri: uri(pageNumber),
    lastUri: uri(pageCount),
    pageCount,
  };
  if (pageNumber < pageCount) {
    body.nextUri = uri(pageNumber + 1);
  }
  if (pageNumber > 1) body.previousUri = uri(pageNumber - 1);
  return { status: 200, body };
}

function userRecord(p: Person) {
  const d = divisionOf(p);
  const phone = p.phone
    ? [{ address: p.phone, mediaType: 'PHONE', type: 'PRIMARY' }]
    : [];
  return {
    id: p.ids.genesys,
    // Genesys holds whatever the provisioning feed wrote; this org's feed
    // upper-cases names. Do not join on it.
    name: (p.firstName + ' ' + p.lastName).toUpperCase(),
    division: { id: d.id, name: d.name, selfUri: '/api/v2/authorization/divisions/' + d.id },
    chat: { jabberId: p.ids.genesys.replace(/-/g, '').slice(0, 24) + '@mock-org.orgspan.example' },
    department: p.department,
    email: p.email,
    primaryContactInfo: [{ address: p.email, mediaType: 'EMAIL', type: 'PRIMARY' }, ...phone],
    addresses: [],
    state: p.genesysActive ? 'active' : 'inactive',
    title: p.employeeNumber,
    username: p.email,
    version: 1 + (p.key.charCodeAt(3) % 9),
    acdAutoAnswer: false,
    selfUri: '/api/v2/users/' + p.ids.genesys,
  };
}

function queueRecord(q: Queue) {
  const d = ref().divisions.find((x) => x.id === q.divisionId)!;
  return {
    id: q.id,
    name: q.name,
    division: { id: d.id, name: d.name, selfUri: '/api/v2/authorization/divisions/' + d.id },
    dateCreated: '2024-03-01T15:00:00.000Z',
    memberCount: q.memberKeys.length,
    userMemberCount: q.memberKeys.length,
    joinedMemberCount: q.memberKeys.length,
    mediaSettings: {
      call: { alertingTimeoutSeconds: 8, serviceLevel: { percentage: 0.8, durationMs: 20000 } },
    },
    acwSettings: { wrapupPrompt: 'MANDATORY_TIMEOUT', timeoutMs: 30000 },
    skillEvaluationMethod: 'ALL',
    selfUri: '/api/v2/routing/queues/' + q.id,
  };
}

// ---------------------------------------------------------------------------
// Conversation activity, per anchor
// ---------------------------------------------------------------------------

type Conversation = {
  queueId: string;
  offeredAt: number;
  waitMs: number;
  outcome: 'answered' | 'abandoned';
  talkMs: number;
  acwMs: number;
};

let cache: { anchor: number; conversations: Conversation[] } | undefined;

function conversations(): Conversation[] {
  const anchor = activityAnchor();
  if (cache?.anchor !== activityKey()) cache = { anchor: activityKey(), conversations: generate(anchor) };
  return cache.conversations;
}

function generate(anchor: number): Conversation[] {
  const rng = streamFor('genesys-activity', anchor);
  const incidentFrom = anchor - PLANTED_WINDOW_MS;
  const out: Conversation[] = [];

  for (const q of ref().queues) {
    const planted = plantedActive() && q.name === PLANTED_QUEUE;
    const subtle = plantedActive() && q.name === SUBTLE_QUEUE;
    // Minute by minute, with a daytime curve: a contact centre at 3am and at
    // 11am are different systems.
    for (let t = anchor - ACTIVITY_WINDOW_MS; t < anchor; t += 60_000) {
      const hour = new Date(t).getUTCHours();
      const daytime = hour >= 13 && hour <= 23;   // 8am-6pm Central, roughly
      const surge = planted && t >= incidentFrom;
      // The surge ignores the time of day, so the planted incident is there
      // whenever the mock server is queried, not only in Texas office hours.
      const rate = surge ? 1.8 : subtle && t >= incidentFrom ? 1.8 : daytime ? 0.9 : 0.1;
      let arrivals = Math.floor(rate) + (rng() < rate % 1 ? 1 : 0);
      while (arrivals-- > 0) {
        const waitMs = surge ? 180_000 + Math.floor(rng() * 540_000) : Math.floor(rng() * 45_000);
        const abandoned = surge ? rng() < 0.4 : rng() < 0.03;
        out.push({
          queueId: q.id,
          offeredAt: t + Math.floor(rng() * 60_000),
          waitMs: abandoned ? Math.floor(waitMs * rng()) : waitMs,
          outcome: abandoned ? 'abandoned' : 'answered',
          talkMs: abandoned ? 0 : 60_000 + Math.floor(rng() * 480_000),
          acwMs: abandoned ? 0 : 5_000 + Math.floor(rng() * 25_000),
        });
      }
    }
  }
  return out;
}

const AGGREGATE_METRICS = ['nOffered', 'tAnswered', 'tAbandon', 'tWait', 'tTalk', 'tAcw', 'tHandle'] as const;
type AggregateMetric = (typeof AGGREGATE_METRICS)[number];

function queueIdsFrom(filter: unknown): Set<string> | undefined {
  if (filter === undefined) return undefined;
  const f = filter as { predicates?: Array<{ dimension?: string; value?: string }>; clauses?: unknown };
  if (f.clauses !== undefined || !Array.isArray(f.predicates)) {
    throw new BadRequest('mock models only a flat filter of queueId predicates');
  }
  const ids = new Set<string>();
  for (const p of f.predicates) {
    if (p.dimension !== 'queueId' || typeof p.value !== 'string') {
      throw new BadRequest('mock models only queueId predicates, got ' + String(p.dimension));
    }
    ids.add(p.value);
  }
  return ids;
}

const GRANULARITY_MS: Record<string, number> = {
  PT15M: 15 * 60_000, PT30M: 30 * 60_000, PT1H: 60 * 60_000, P1D: 24 * 60 * 60_000,
};

function aggregatesQuery(req: MockRequest): MockResponse {
  const body = jsonBody(req);
  const interval = String(body.interval ?? '');
  const [fromText, toText] = interval.split('/');
  const from = Date.parse(fromText);
  const to = Date.parse(toText);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
    throw new BadRequest('interval must be two ISO-8601 instants separated by /');
  }
  const groupBy = (body.groupBy ?? []) as string[];
  if (groupBy.some((g) => g !== 'queueId' && g !== 'mediaType')) {
    throw new BadRequest('mock models groupBy queueId and mediaType only');
  }
  const metrics = (body.metrics ?? AGGREGATE_METRICS) as string[];
  for (const m of metrics) {
    if (!(AGGREGATE_METRICS as readonly string[]).includes(m)) throw new BadRequest('unsupported metric ' + m);
  }
  const granularity = body.granularity === undefined ? undefined : String(body.granularity);
  const step = granularity === undefined ? to - from : GRANULARITY_MS[granularity];
  if (!step) throw new BadRequest('mock models granularity PT15M, PT30M, PT1H, P1D');

  const queues = queueIdsFrom(body.filter);
  const rows = conversations().filter((c) =>
    c.offeredAt >= from && c.offeredAt < to && (!queues || queues.has(c.queueId)));

  const groups = new Map<string, Conversation[]>();
  for (const c of rows) {
    const key = groupBy.includes('queueId') ? c.queueId : '';
    const list = groups.get(key);
    if (list) list.push(c); else groups.set(key, [c]);
  }

  const results = [...groups.entries()].map(([queueId, convs]) => {
    const data: Array<{ interval: string; metrics: unknown[] }> = [];
    for (let s = from; s < to; s += step) {
      const inBucket = convs.filter((c) => c.offeredAt >= s && c.offeredAt < s + step);
      if (inBucket.length === 0) continue;
      const out = metrics.map((m) => stat(m as AggregateMetric, inBucket)).filter((x) => x !== undefined);
      data.push({ interval: iso(s) + '/' + iso(Math.min(s + step, to)), metrics: out });
    }
    const group: Record<string, string> = { mediaType: 'voice' };
    if (queueId) group.queueId = queueId;
    return { group, data };
  });

  return { status: 200, body: { results } };
}

/** One metric over a bucket. Undefined when nothing qualifies - absent, not zero. */
function stat(metric: AggregateMetric, convs: Conversation[]) {
  const pick = (vals: number[]) => vals.length === 0 ? undefined : {
    metric,
    stats: { max: Math.max(...vals), min: Math.min(...vals), count: vals.length, sum: vals.reduce((a, b) => a + b, 0) },
  };
  const answered = convs.filter((c) => c.outcome === 'answered');
  switch (metric) {
    case 'nOffered': return { metric, stats: { count: convs.length } };
    case 'tAnswered': return pick(answered.map((c) => c.waitMs));
    case 'tAbandon': return pick(convs.filter((c) => c.outcome === 'abandoned').map((c) => c.waitMs));
    case 'tWait': return pick(convs.map((c) => c.waitMs));
    case 'tTalk': return pick(answered.map((c) => c.talkMs));
    case 'tAcw': return pick(answered.map((c) => c.acwMs));
    case 'tHandle': return pick(answered.map((c) => c.talkMs + c.acwMs));
  }
}

const OBSERVATION_METRICS = ['oWaiting', 'oInteracting', 'oOnQueueUsers', 'oMemberUsers', 'oActiveUsers'] as const;

function observationsQuery(req: MockRequest): MockResponse {
  const body = jsonBody(req);
  const queues = queueIdsFrom(body.filter);
  if (!queues || queues.size === 0) throw new BadRequest('filter must name at least one queueId');
  const metrics = (body.metrics ?? OBSERVATION_METRICS) as string[];
  for (const m of metrics) {
    if (!(OBSERVATION_METRICS as readonly string[]).includes(m)) throw new BadRequest('unsupported metric ' + m);
  }

  const anchor = activityAnchor();
  const rng = streamFor('genesys-observations', anchor);
  const results = ref().queues.filter((q) => queues.has(q.id)).map((q) => {
    const planted = plantedActive() && q.name === PLANTED_QUEUE;
    const members = q.memberKeys.length;
    const onQueue = Math.max(1, Math.floor(members * (planted ? 0.5 : 0.6)));
    const interacting = planted ? onQueue : Math.floor(onQueue * (0.4 + rng() * 0.4));
    const waiting = planted ? 20 + Math.floor(rng() * 12) : Math.floor(rng() * 3);
    type Row = { metric: string; qualifier?: string; stats: { count: number } };
    const data = metrics.flatMap((m): Row[] => {
      switch (m) {
        case 'oWaiting': return [{ metric: m, stats: { count: waiting } }];
        case 'oInteracting': return [{ metric: m, stats: { count: interacting } }];
        case 'oMemberUsers': return [{ metric: m, stats: { count: members } }];
        case 'oActiveUsers': return [{ metric: m, stats: { count: onQueue + 2 } }];
        // Split by routing status via `qualifier`, as the real response does.
        // Summing every row for oOnQueueUsers double-counts nobody, but
        // reading only the first row undercounts everybody.
        default: return [
          { metric: m, qualifier: 'INTERACTING', stats: { count: interacting } },
          { metric: m, qualifier: 'IDLE', stats: { count: onQueue - interacting } },
        ];
      }
    });
    return { group: { queueId: q.id, mediaType: 'voice' }, data };
  });
  return { status: 200, body: { systemToOrganizationMappings: {}, results } };
}

export const genesysApi: MockApp = createApp('genesys', 'api', [
  {
    method: 'GET',
    pattern: '/api/v2/users',
    handler(req) {
      const state = req.query.get('state') ?? 'active';
      if (!['active', 'inactive', 'any'].includes(state)) throw new BadRequest('state must be active, inactive or any');
      const rows = genesysPeople()
        .filter((p) => state === 'any' || (state === 'active') === p.genesysActive)
        .map(userRecord);
      return entityListing(req, rows, state === 'active' ? {} : { state });
    },
  },
  {
    method: 'GET',
    pattern: '/api/v2/users/:userId',
    handler(_req, { userId }) {
      const p = genesysPeople().find((x) => x.ids.genesys === userId);
      return p ? { status: 200, body: userRecord(p) } : genesysError(404, '', 'user ' + userId + ' not found');
    },
  },
  {
    method: 'GET',
    pattern: '/api/v2/authorization/divisions',
    handler(req) {
      const rows = ref().divisions.map((d) => ({
        id: d.id, name: d.name, homeDivision: d.name === 'Home',
        selfUri: '/api/v2/authorization/divisions/' + d.id,
      }));
      return entityListing(req, rows);
    },
  },
  {
    method: 'GET',
    pattern: '/api/v2/routing/queues',
    handler(req) {
      return entityListing(req, ref().queues.map(queueRecord));
    },
  },
  {
    method: 'GET',
    pattern: '/api/v2/routing/queues/:queueId/members',
    handler(req, { queueId }) {
      const q = ref().queues.find((x) => x.id === queueId);
      if (!q) return genesysError(404, '', 'queue ' + queueId + ' not found');
      const people = genesysPeople();
      const rows = q.memberKeys.map((key) => {
        const p = people.find((x) => x.key === key)!;
        return {
          id: p.ids.genesys,
          name: (p.firstName + ' ' + p.lastName).toUpperCase(),
          user: { id: p.ids.genesys, name: (p.firstName + ' ' + p.lastName).toUpperCase(), selfUri: '/api/v2/users/' + p.ids.genesys },
          ringNumber: 1,
          joined: true,
          memberBy: 'user',
          selfUri: '/api/v2/users/' + p.ids.genesys,
        };
      });
      return entityListing(req, rows);
    },
  },
  {
    method: 'POST',
    pattern: '/api/v2/analytics/queues/observations/query',
    handler: observationsQuery,
  },
  {
    method: 'POST',
    pattern: '/api/v2/analytics/conversations/aggregates/query',
    handler: aggregatesQuery,
  },
], (status, code, message) => genesysError(status, code, message));

/** For tests and docs: the queue ids, since they are generated. */
export function genesysQueues(): Array<{ id: string; name: string }> {
  return ref().queues.map((q) => ({ id: q.id, name: q.name }));
}

