/**
 * ---------------------------------------------------------------------------
 * Microsoft Teams, as seen through Microsoft Graph - the mock
 * ---------------------------------------------------------------------------
 * Two hosts, as in production:
 *
 *   login.microsoftonline.com   POST /{tenant}/oauth2/v2.0/token
 *   graph.microsoft.com         GET  /v1.0/users
 *                               GET  /v1.0/admin/teams/userConfigurations
 *                               GET  /v1.0/communications/callRecords
 *                               GET  /v1.0/communications/callRecords/{id}
 *                               GET  /v1.0/communications/callRecords/
 *                                      getDirectRoutingCalls(fromDateTime=..,toDateTime=..)
 *
 * Shapes modelled from the published Graph v1.0 reference, not captured from a
 * tenant. The Teams admin resources in particular are young; check the
 * property names and which `$filter` clauses the real service accepts before
 * relying on this.
 *
 * THE TRAPS THIS MOCK KEEPS, because a connector written against a friendlier
 * mock would pass here and fail live:
 *
 *   - `/users` returns Graph's DEFAULT property set. `streetAddress` - where the
 *     facility code lives - and `department` only come back if you ask for them
 *     with `$select`. Forget it and every user is "no facility", silently.
 *   - `userConfigurations` returns EVERY Entra account, voice or not. Filter on
 *     `isEnterpriseVoiceEnabled eq true`, and still drop `resourceAccount`s -
 *     an auto attendant is voice-enabled and is not a member of staff.
 *   - `@odata.nextLink` carries an opaque `$skiptoken`. Follow it verbatim.
 *   - Call-quality numbers are ISO-8601 DURATIONS (`PT0.018S`), not
 *     milliseconds. Reading them with Number() gives NaN, and NaN compares
 *     false against every threshold, so the bad calls look fine.
 *
 * WHAT IS PLANTED, so the later pipeline has something real to find: for the
 * last forty minutes, the second SBC trunk fails most calls with SIP 503, and
 * calls from the Houston facility (LC=1120) show heavy loss and jitter. The
 * Webex mock plants the same Houston degradation - two independent services
 * seeing one site's WAN go bad is corroboration in exactly the sense the
 * network side means it.
 */
import { now } from '../../../platform/clock.ts';
import { seededUuid } from '../../../platform/crypto.ts';
import type { Random } from '../../../platform/random.ts';
import {
  BadRequest, createApp, DEMO_CLIENT, decodeCursor, encodeCursor, intParam, issueToken,
  withQuery, type MockApp, type MockRequest, type MockResponse,
} from './kernel.ts';
import { b64urlDecodeText, b64urlEncode } from '../../../platform/crypto.ts';
import { directory, streamFor, type Person } from './directory.ts';
import { ACTIVITY_WINDOW_MS, activityAnchor, activityKey, iso, isoDuration, PLANTED_WINDOW_MS, plantedActive } from './time.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const GRAPH_TOKEN_TTL_S = 3599;

export const TEAMS_TRUNKS = ['sbc1.voice.hhs.texas.example', 'sbc2.voice.hhs.texas.example'] as const;
/** The trunk that is failing, and the facility whose calls are degraded. */
export const PLANTED = { failingTrunk: TEAMS_TRUNKS[1], degradedFacility: '1120' } as const;

// ---------------------------------------------------------------------------
// login.microsoftonline.com
// ---------------------------------------------------------------------------

function aadError(status: number, error: string, description: string): MockResponse {
  return {
    status,
    body: {
      error,
      error_description: description,
      error_codes: [status === 401 ? 7000215 : 90002],
      timestamp: iso(now()),
      trace_id: '00000000-0000-0000-0000-000000000000',
      correlation_id: '00000000-0000-0000-0000-000000000000',
    },
  };
}

export const teamsLogin: MockApp = createApp('teams', 'login', [
  {
    method: 'POST',
    pattern: '/:tenant/oauth2/v2.0/token',
    public: true,
    handler(req, { tenant }) {
      if (tenant !== directory().entraTenantId) {
        return aadError(400, 'invalid_request', 'AADSTS90002: Tenant \'' + tenant + '\' not found.');
      }
      const form = new URLSearchParams(req.body);
      if (form.get('grant_type') !== 'client_credentials') {
        return aadError(400, 'unsupported_grant_type', 'AADSTS70003: only client_credentials is modelled.');
      }
      if (form.get('client_id') !== DEMO_CLIENT.clientId ||
          form.get('client_secret') !== DEMO_CLIENT.clientSecret) {
        return aadError(401, 'invalid_client', 'AADSTS7000215: Invalid client secret provided.');
      }
      // Application permissions only come through the `.default` scope. A
      // delegated-style scope here is a common first mistake.
      if (form.get('scope') !== 'https://graph.microsoft.com/.default') {
        return aadError(400, 'invalid_scope', 'AADSTS1002012: scope must be https://graph.microsoft.com/.default');
      }
      return {
        status: 200,
        body: {
          token_type: 'Bearer',
          expires_in: GRAPH_TOKEN_TTL_S,
          ext_expires_in: GRAPH_TOKEN_TTL_S,
          access_token: issueToken('teams', GRAPH_TOKEN_TTL_S),
        },
      };
    },
  },
], (status, _code, message) => aadError(status, 'server_error', message));

// ---------------------------------------------------------------------------
// graph.microsoft.com
// ---------------------------------------------------------------------------

function graphError(status: number, _code: string, message: string): MockResponse {
  const code = status === 410 ? 'resyncRequired'
    : status === 401 ? 'InvalidAuthenticationToken'
    : status === 429 ? 'TooManyRequests'
      : status === 400 ? 'BadRequest'
        : status === 503 ? 'ServiceUnavailable'
          : 'generalException';
  return {
    status,
    body: {
      error: {
        code,
        message,
        innerError: {
          date: iso(now()),
          'request-id': '00000000-0000-0000-0000-000000000000',
          'client-request-id': '00000000-0000-0000-0000-000000000000',
        },
      },
    },
  };
}

/** One page of a Graph collection, with `@odata.nextLink` when there is more. */
function graphPage(
  req: MockRequest, context: string, all: unknown[], defaultTop: number, maxTop: number,
  extra: Record<string, unknown> = {},
): MockResponse {
  const top = intParam(req, '$top', defaultTop, 1, maxTop);
  const offset = decodeCursor(req.query.get('$skiptoken'));
  const value = all.slice(offset, offset + top);
  const body: Record<string, unknown> = { '@odata.context': GRAPH + '/$metadata#' + context, ...extra, value };
  if (offset + top < all.length) {
    body['@odata.nextLink'] = withQuery(req, { $skiptoken: encodeCursor(offset + top) });
  }
  return { status: 200, body };
}

const USER_DEFAULT_PROPS = [
  'businessPhones', 'displayName', 'givenName', 'jobTitle', 'mail', 'mobilePhone',
  'officeLocation', 'preferredLanguage', 'surname', 'userPrincipalName', 'id',
] as const;

// ---------------------------------------------------------------------------
// Directory changes, for /users/delta
// ---------------------------------------------------------------------------

/**
 * Changes made to Entra after the directory was generated: a person moves
 * building, is renamed, or leaves. Tests and the demo drive these; the delta
 * endpoint reports them.
 *
 * VERSIONED, because that is what a delta token is: "everything after version
 * N". A token that remembered a TIME instead would miss a change stamped a
 * moment before a slow page finished - the same gap the network watermarks
 * overlap to avoid.
 */
type Change = { version: number; removed: boolean; props: Record<string, unknown> };
let entraVersion = 0;
const changes = new Map<string, Change>();

/** Move, rename or otherwise edit one Entra user. Props are merged over the directory's. */
export function mutateEntraUser(
  id: string, patch: { streetAddress?: string | null; userPrincipalName?: string },
): void {
  entraVersion++;
  const prev = changes.get(id);
  changes.set(id, { version: entraVersion, removed: false, props: { ...prev?.props, ...patch } });
}

export function removeEntraUser(id: string): void {
  entraVersion++;
  changes.set(id, { version: entraVersion, removed: true, props: {} });
}

export function resetEntraChanges(): void {
  entraVersion = 0;
  changes.clear();
}

/** How long a delta token stays valid. Seven days per Graph's guidance - verify for users. */
export const DELTA_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function entraUsers(): Record<string, unknown>[] {
  return baseEntraUsers()
    .filter((u) => !changes.get(String(u.id))?.removed)
    .map((u) => ({ ...u, ...changes.get(String(u.id))?.props }));
}

function baseEntraUsers(): Record<string, unknown>[] {
  const d = directory();
  const people = d.people.filter((p) => p.inTeams).map((p) => ({
    id: p.ids.entra,
    displayName: p.firstName + ' ' + p.lastName,
    givenName: p.firstName,
    surname: p.lastName,
    mail: p.email,
    userPrincipalName: p.email,
    jobTitle: null,
    department: p.department,
    businessPhones: p.teamsVoice && p.phone ? [p.phone] : [],
    mobilePhone: null,
    officeLocation: p.facility?.name ?? null,
    preferredLanguage: 'en-US',
    streetAddress: p.streetAddress,
    city: p.facility?.city ?? null,
    state: 'TX',
    employeeId: p.employeeNumber,
  }));
  const resources = d.resourceAccounts.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    givenName: null,
    surname: null,
    mail: null,
    userPrincipalName: r.upn,
    jobTitle: null,
    department: null,
    businessPhones: [],
    mobilePhone: null,
    officeLocation: null,
    preferredLanguage: null,
    streetAddress: null,
    city: null,
    state: null,
    employeeId: null,
  }));
  return [...people, ...resources];
}

function selectProps(rows: Record<string, unknown>[], select: string | null): Record<string, unknown>[] {
  const props = select ? select.split(',').map((s) => s.trim()) : [...USER_DEFAULT_PROPS];
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const p of props) {
      if (!(p in r)) throw new BadRequest('Could not find a property named \'' + p + '\' on type \'microsoft.graph.user\'.');
      out[p] = r[p];
    }
    return out;
  });
}

function userConfigurations(): Record<string, unknown>[] {
  const d = directory();
  const created = '2023-02-14T16:00:00Z';
  const person = (p: Person) => ({
    id: p.ids.entra,
    tenantId: d.entraTenantId,
    userPrincipalName: p.email,
    accountType: 'user',
    isEnterpriseVoiceEnabled: p.teamsVoice,
    featureTypes: p.teamsVoice ? ['Teams', 'AudioConferencing', 'PhoneSystem'] : ['Teams'],
    telephoneNumbers: p.teamsVoice && p.phone
      ? [{ telephoneNumber: p.phone, assignmentCategory: 'primary' }]
      : [],
    effectivePolicyAssignments: [
      {
        policyType: 'TeamsCallingPolicy',
        policyAssignment: { displayName: 'Global', assignmentType: 'direct', policyId: 'Global' },
      },
    ],
    createdDateTime: created,
    modifiedDateTime: '2026-06-01T12:00:00Z',
  });
  const resource = (r: (typeof d.resourceAccounts)[number]) => ({
    id: r.id,
    tenantId: d.entraTenantId,
    userPrincipalName: r.upn,
    accountType: 'resourceAccount',
    isEnterpriseVoiceEnabled: true,
    featureTypes: ['PhoneSystemVirtualUser'],
    telephoneNumbers: [{ telephoneNumber: r.phone, assignmentCategory: 'primary' }],
    effectivePolicyAssignments: [],
    createdDateTime: created,
    modifiedDateTime: created,
  });
  return [...d.people.filter((p) => p.inTeams).map(person), ...d.resourceAccounts.map(resource)];
}

/**
 * The `$filter` subset the mock understands. Anything else is a 400 naming the
 * clause, so an unsupported filter is loud rather than silently ignored -
 * silently ignoring it would return all 75,000 accounts, which is the problem
 * the filter was there to avoid.
 */
function filterConfigurations(rows: Record<string, unknown>[], filter: string | null) {
  if (!filter) return rows;
  const clauses = filter.split(/\s+and\s+/i);
  return rows.filter((r) => clauses.every((c) => {
    let m = /^isEnterpriseVoiceEnabled eq (true|false)$/.exec(c.trim());
    if (m) return r.isEnterpriseVoiceEnabled === (m[1] === 'true');
    m = /^accountType eq '(\w+)'$/.exec(c.trim());
    if (m) return r.accountType === m[1];
    m = /^userPrincipalName eq '([^']+)'$/.exec(c.trim());
    if (m) return String(r.userPrincipalName).toLowerCase() === m[1].toLowerCase();
    throw new BadRequest('Invalid filter clause: ' + c.trim());
  }));
}

// ---------------------------------------------------------------------------
// Call activity - regenerated per five-minute anchor, see time.ts
// ---------------------------------------------------------------------------

type Activity = {
  directRouting: Record<string, unknown>[];
  callRecords: Array<{ summary: Record<string, unknown>; sessions: Record<string, unknown>[] }>;
};

let cache: { anchor: number; activity: Activity } | undefined;

function activity(): Activity {
  const anchor = activityAnchor();
  if (cache?.anchor !== activityKey()) cache = { anchor: activityKey(), activity: generate(anchor) };
  return cache.activity;
}

function generate(anchor: number): Activity {
  const rng = streamFor('teams-activity', anchor);
  const id = seededUuid(rng);
  const voice = directory().people.filter((p) => p.teamsVoice && p.phone);
  const start = anchor - ACTIVITY_WINDOW_MS;
  const incidentFrom = anchor - PLANTED_WINDOW_MS;

  // --- Direct Routing: PSTN calls over the customer's own SBCs -------------
  const directRouting: Record<string, unknown>[] = [];
  const pstnCall = (p: Person, invite: number, trunk: string) => {
    const planted = plantedActive() && trunk === PLANTED.failingTrunk && invite >= incidentFrom;
    const failed = planted ? rng() < 0.7 : rng() < 0.02;
    const duration = failed ? 0 : 20 + Math.floor(rng() * 600);
    const inbound = rng() < 0.5;
    const external = '+1' + String(2100000000 + Math.floor(rng() * 7000000000));
    directRouting.push({
      id: id(),
      correlationId: id(),
      userId: p.ids.entra,
      userPrincipalName: p.email,
      userDisplayName: p.firstName + ' ' + p.lastName,
      startDateTime: failed ? null : iso(invite + 2000),
      inviteDateTime: iso(invite),
      failureDateTime: failed ? iso(invite + 1500) : null,
      endDateTime: iso(invite + 2000 + duration * 1000),
      duration,
      callType: inbound ? 'ByotIn' : 'ByotOut',
      successfulCall: !failed,
      callerNumber: inbound ? external : p.phone,
      calleeNumber: inbound ? p.phone : external,
      mediaPathLocation: 'USSC',
      signalingLocation: 'USSC',
      // 0 for a completed call, as the Direct Routing report shows it.
      finalSipCode: failed ? (planted ? 503 : 487) : 0,
      finalSipCodePhrase: failed ? (planted ? 'Service Unavailable' : 'Request Terminated') : 'BYE',
      callEndSubReason: failed ? (planted ? 560503 : 540487) : 0,
      trunkFullyQualifiedDomainName: trunk,
      mediaBypassEnabled: false,
    });
  };
  // Background traffic across the whole day...
  for (const p of voice) {
    const calls = 1 + Math.floor(rng() * 5);
    for (let c = 0; c < calls; c++) {
      pstnCall(p, start + Math.floor(rng() * ACTIVITY_WINDOW_MS), TEAMS_TRUNKS[rng() < 0.5 ? 0 : 1]);
    }
  }
  // ...and a busy incident window. Uniform background alone puts a handful of
  // calls in forty minutes, too few for "most calls on sbc2 fail" to be a
  // pattern rather than noise - to the tests or to the anomaly rule.
  for (let c = 0; c < 60; c++) {
    const p = voice[Math.floor(rng() * voice.length)];
    pstnCall(p, incidentFrom + Math.floor(rng() * PLANTED_WINDOW_MS), TEAMS_TRUNKS[c % 2]);
  }
  directRouting.sort((a, b) => String(a.inviteDateTime).localeCompare(String(b.inviteDateTime)));

  // --- Teams-to-Teams VoIP calls, with media quality ----------------------
  const callRecords: Activity['callRecords'] = [];
  const count = 140;
  const houston = voice.filter((p) => p.facility?.code === PLANTED.degradedFacility);
  for (let i = 0; i < count; i++) {
    // The last twenty are pinned into the incident window with a Houston
    // caller, for the same reason as the PSTN burst above.
    const burst = i >= count - 20 && houston.length > 0;
    const caller = burst ? houston[i % houston.length] : voice[Math.floor(rng() * voice.length)];
    let callee = voice[Math.floor(rng() * voice.length)];
    if (callee === caller) callee = voice[(voice.indexOf(caller) + 1) % voice.length];
    const t0 = burst
      ? incidentFrom + Math.floor(rng() * (PLANTED_WINDOW_MS - 60_000))
      : start + Math.floor(rng() * ACTIVITY_WINDOW_MS);
    const seconds = 30 + Math.floor(rng() * 1200);
    const degraded = plantedActive() && t0 >= incidentFrom &&
      (caller.facility?.code === PLANTED.degradedFacility || callee.facility?.code === PLANTED.degradedFacility);
    const recordId = id();
    const sessionId = id();

    const endpoint = (p: Person) => ({
      '@odata.type': '#microsoft.graph.callRecords.participantEndpoint',
      identity: { user: { id: p.ids.entra, displayName: p.firstName + ' ' + p.lastName, tenantId: directory().entraTenantId } },
      userAgent: {
        '@odata.type': '#microsoft.graph.callRecords.clientUserAgent',
        headerValue: 'RTCC/7.0.0.0 UCWA/7.0.0.0 TeamsDesktop',
        platform: 'windows',
        productFamily: 'teams',
      },
    });

    callRecords.push({
      summary: {
        id: recordId,
        version: 1,
        type: 'peerToPeer',
        modalities: ['audio'],
        lastModifiedDateTime: iso(t0 + seconds * 1000 + 60_000),
        startDateTime: iso(t0),
        endDateTime: iso(t0 + seconds * 1000),
        joinWebUrl: null,
        organizer_v2: { id: caller.ids.entra, identity: { user: { id: caller.ids.entra, displayName: caller.firstName + ' ' + caller.lastName } } },
        participants_v2: [caller, callee].map((p) => ({
          id: p.ids.entra, identity: { user: { id: p.ids.entra, displayName: p.firstName + ' ' + p.lastName } },
        })),
      },
      sessions: [{
        id: sessionId,
        modalities: ['audio'],
        startDateTime: iso(t0),
        endDateTime: iso(t0 + seconds * 1000),
        caller: endpoint(caller),
        callee: endpoint(callee),
        failureInfo: null,
        segments: [{
          id: sessionId,
          startDateTime: iso(t0),
          endDateTime: iso(t0 + seconds * 1000),
          caller: endpoint(caller),
          callee: endpoint(callee),
          failureInfo: null,
          media: [{
            label: 'main-audio',
            callerNetwork: network(caller, rng),
            calleeNetwork: network(callee, rng),
            streams: [streamStats('callerToCallee', degraded, rng), streamStats('calleeToCaller', degraded, rng)],
          }],
        }],
      }],
    });
  }
  callRecords.sort((a, b) => String(a.summary.startDateTime).localeCompare(String(b.summary.startDateTime)));

  return { directRouting, callRecords };
}

function network(p: Person, rng: Random) {
  return {
    connectionType: rng() < 0.7 ? 'wired' : 'wifi',
    // The facility is NOT on the call record - only the subnet is. Mapping a
    // subnet back to a building is the job Teams' own "building data" upload
    // does, and something the knowledge graph will need a table for.
    subnet: '10.' + (p.facility ? Number(p.facility.code) % 250 : 0) + '.0.0',
    ipAddress: '10.' + (p.facility ? Number(p.facility.code) % 250 : 0) + '.0.' + String(10 + Math.floor(rng() * 200)),
    linkSpeed: 1_000_000_000,
  };
}

function streamStats(direction: 'callerToCallee' | 'calleeToCaller', degraded: boolean, rng: Random) {
  const jitter = degraded ? 0.04 + rng() * 0.05 : 0.002 + rng() * 0.01;
  const loss = degraded ? 0.05 + rng() * 0.08 : rng() * 0.004;
  const rtt = degraded ? 0.18 + rng() * 0.2 : 0.02 + rng() * 0.05;
  return {
    streamId: String(Math.floor(rng() * 1e9)),
    streamDirection: direction,
    averageJitter: isoDuration(jitter),
    maxJitter: isoDuration(jitter * 3),
    averagePacketLossRate: round(loss, 4),
    maxPacketLossRate: round(Math.min(1, loss * 2.5), 4),
    averageRoundTripTime: isoDuration(rtt),
    maxRoundTripTime: isoDuration(rtt * 2),
    averageAudioDegradation: round(degraded ? 1.5 + rng() * 1.5 : rng() * 0.3, 2),
    averageAudioNetworkJitter: isoDuration(jitter * 1.2),
    packetUtilization: 1000 + Math.floor(rng() * 40000),
    wasMediaBypassed: false,
    lowVideoProcessingCapabilityRatio: null,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** `startDateTime ge X [and startDateTime lt Y]` - the only callRecords filter modelled. */
function callRecordWindow(filter: string | null): { from: number; to: number } {
  if (!filter) return { from: -Infinity, to: Infinity };
  let from = -Infinity;
  let to = Infinity;
  for (const clause of filter.split(/\s+and\s+/i)) {
    const m = /^startDateTime (ge|gt|le|lt) (\S+)$/.exec(clause.trim());
    const t = m ? Date.parse(m[2]) : NaN;
    if (!m || Number.isNaN(t)) throw new BadRequest('Invalid filter clause: ' + clause.trim());
    if (m[1] === 'ge' || m[1] === 'gt') from = t;
    else to = t;
  }
  return { from, to };
}

type DeltaState =
  | { k: 'initial'; o: number; v: number; s: string | null }
  | { k: 'changes'; o: number; from: number; to: number; s: string | null }
  | { k: 'link'; v: number; t: number; s: string | null };

const encodeState = (st: DeltaState) => b64urlEncode(JSON.stringify(st));
function decodeState(token: string): DeltaState {
  try {
    return JSON.parse(b64urlDecodeText(token)) as DeltaState;
  } catch {
    throw new BadRequest('invalid delta or skip token');
  }
}

/**
 * `GET /users/delta` - a full listing first, then only what changed.
 *
 * THE TRAPS, faithful to the real endpoint:
 *   - The first sync is a full listing, paged by `$skiptoken`, and only its
 *     LAST page carries `@odata.deltaLink`. Stop early and you have no
 *     deltaLink - resume from the nextLink you saved, or start again.
 *   - Page size is set by the `Prefer: odata.maxpagesize` HEADER, not `$top`.
 *   - `$select` is remembered INSIDE the tokens. A client that appends it to
 *     a nextLink is building URLs it was told to treat as opaque.
 *   - A changed user comes back with its id and ONLY the changed properties.
 *     A client that overwrites its record with the row blanks every field
 *     the change did not touch.
 *   - A removed user is `{ id, '@removed': { reason } }` and nothing else.
 *   - A delta token older than seven days is a 410: resync from scratch.
 */
function usersDelta(req: MockRequest): MockResponse {
  const pref = /odata\.maxpagesize=(\d+)/.exec(req.headers.get('prefer') ?? '');
  const pageSize = Math.min(999, Math.max(1, pref ? Number(pref[1]) : 100));
  const skip = req.query.get('$skiptoken');
  const delta = req.query.get('$deltatoken');
  const link = (st: DeltaState) =>
    req.base + req.path + '?' + (st.k === 'link' ? '$deltatoken=' : '$skiptoken=') + encodeState(st);

  let state: DeltaState;
  if (skip) state = decodeState(skip);
  else if (delta) {
    const d = decodeState(delta);
    if (d.k !== 'link') throw new BadRequest('invalid delta token');
    if (now() - d.t > DELTA_TOKEN_TTL_MS) {
      return graphError(410, '', 'Resync required. The delta token has expired; restart with a full sync.');
    }
    state = { k: 'changes', o: 0, from: d.v, to: entraVersion, s: d.s };
  } else {
    state = { k: 'initial', o: 0, v: entraVersion, s: req.query.get('$select') };
  }
  if (state.k === 'link') throw new BadRequest('a delta token is not a skip token');

  let rows: Record<string, unknown>[];
  if (state.k === 'initial') {
    rows = selectProps(entraUsers(), state.s);
  } else {
    const { from, to } = state;
    const selected = state.s ? state.s.split(',').map((x) => x.trim()) : [...USER_DEFAULT_PROPS];
    rows = [...changes.entries()]
      .filter(([, c]) => c.version > from && c.version <= to)
      .sort(([, a], [, b]) => a.version - b.version)
      .map(([id, c]) => c.removed
        ? { id, '@removed': { reason: 'deleted' } }
        : { id, ...Object.fromEntries(Object.entries(c.props).filter(([k]) => selected.includes(k))) });
  }

  const page = rows.slice(state.o, state.o + pageSize);
  const body: Record<string, unknown> = { '@odata.context': GRAPH + '/$metadata#users', value: page };
  if (state.o + pageSize < rows.length) {
    body['@odata.nextLink'] = link({ ...state, o: state.o + pageSize });
  } else {
    // The deltaLink's version is where the sync STARTED, not where it ended:
    // a change made while a long initial listing was being paged may or may
    // not be on a page already fetched, so the next delta must include it.
    const v = state.k === 'initial' ? state.v : state.to;
    body['@odata.deltaLink'] = link({ k: 'link', v, t: now(), s: state.s });
  }
  return { status: 200, body };
}

export const teamsGraph: MockApp = createApp('teams', 'graph', [
  {
    method: 'GET',
    pattern: '/v1.0/users/delta',
    handler: usersDelta,
  },
  {
    method: 'GET',
    pattern: '/v1.0/users',
    handler(req) {
      if (req.query.has('$filter') || req.query.has('$search')) {
        throw new BadRequest('$filter/$search on /users is not modelled by the mock; page and filter client-side.');
      }
      const rows = selectProps(entraUsers(), req.query.get('$select'));
      return graphPage(req, 'users', rows, 100, 999);
    },
  },
  {
    method: 'GET',
    pattern: '/v1.0/admin/teams/userConfigurations',
    handler(req) {
      const rows = filterConfigurations(userConfigurations(), req.query.get('$filter'));
      return graphPage(req, 'admin/teams/userConfigurations', rows, 100, 999);
    },
  },
  {
    method: 'GET',
    pattern: '/v1.0/communications/callRecords',
    handler(req) {
      const { from, to } = callRecordWindow(req.query.get('$filter'));
      const rows = activity().callRecords
        .filter((r) => {
          const t = Date.parse(String(r.summary.startDateTime));
          return t >= from && t < to;
        })
        .map((r) => r.summary);
      return graphPage(req, 'communications/callRecords', rows, 60, 60);
    },
  },
  // Before `callRecords/:id`, which would otherwise swallow this path as an id.
  {
    method: 'GET',
    pattern: /^\/v1\.0\/communications\/callRecords\/(?:microsoft\.graph\.callRecords\.)?getDirectRoutingCalls\(fromDateTime=(?<from>[^,]+),toDateTime=(?<to>[^)]+)\)$/,
    handler(req, { from, to }) {
      const f = Date.parse(from);
      const t = Date.parse(to);
      if (Number.isNaN(f) || Number.isNaN(t) || t <= f) {
        throw new BadRequest('fromDateTime and toDateTime must be ISO-8601 and from < to');
      }
      const rows = activity().directRouting.filter((c) => {
        const at = Date.parse(String(c.inviteDateTime));
        return at >= f && at < t;
      });
      return graphPage(req, 'Collection(microsoft.graph.callRecords.directRoutingLogRow)', rows, 100, 100,
        { '@odata.count': rows.length });
    },
  },
  {
    method: 'GET',
    pattern: '/v1.0/communications/callRecords/:id',
    handler(req, { id }) {
      const record = activity().callRecords.find((r) => r.summary.id === id);
      if (!record) return graphError(404, 'NotFound', 'callRecord ' + id + ' not found');
      // Sessions only come back when expanded, as on the real endpoint - and
      // the media quality lives two levels down, inside segments.
      const expand = req.query.get('$expand') ?? '';
      if (!expand.startsWith('sessions')) return { status: 200, body: record.summary };
      const withSegments = expand.includes('segments');
      return {
        status: 200,
        body: {
          ...record.summary,
          sessions: record.sessions.map((s) => withSegments ? s : { ...s, segments: undefined }),
        },
      };
    },
  },
], (status, code, message) => graphError(status, code, message));
