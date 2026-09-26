/**
 * The Teams / Genesys / Webex mocks, pinned.
 *
 * Each test goes through `mockFetch` with the REAL vendor URL, the way a
 * connector will, and several drain through `drainPages` from http.ts - so
 * what is pinned is the mock as a connector will meet it, not its internals.
 *
 * The traps are asserted as well as the happy paths. A mock that quietly
 * stopped producing the upper-cased domain or the relative `nextUri` would
 * still pass every happy-path test while no longer testing anything.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClock, fixedClock, now, type ControllableClock } from '../../../platform/clock.ts';
import { drainPages, type HttpPage, type PageCursor } from '../../http.ts';
import {
  agencyOf, CDR_VISIBILITY_DELAY_MS, DEMO_CLIENT, DEMO_WEBEX_TOKEN, directory, facilityCodeOf,
  GENESYS_PLANTED_QUEUE, genesysQueues, injectFault, mockFetch, resetMockState, TEAMS_PLANTED,
} from './index.ts';
import { GRAPH_TOKEN_TTL_S } from './teams.ts';
import { PLANTED_WINDOW_MS } from './time.ts';

let clock: ControllableClock;

beforeEach(() => {
  clock = fixedClock();
  setClock(clock);
  resetMockState();
});

type Json = Record<string, any>;

async function json(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GENESYS = 'https://api.use2.us-gov-pure.cloud';
const WEBEX = 'https://webexapis.com/v1';

async function graphToken(): Promise<string> {
  const res = await mockFetch(
    'https://login.microsoftonline.com/' + directory().entraTenantId + '/oauth2/v2.0/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: DEMO_CLIENT.clientId,
        client_secret: DEMO_CLIENT.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }).toString(),
    },
  );
  assert.equal(res.status, 200);
  return (await json(res)).access_token;
}

async function genesysToken(): Promise<string> {
  const res = await mockFetch('https://login.use2.us-gov-pure.cloud/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(DEMO_CLIENT.clientId + ':' + DEMO_CLIENT.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  assert.equal(res.status, 200);
  return (await json(res)).access_token;
}

const bearer = (token: string) => ({ headers: { Authorization: 'Bearer ' + token } });

/** Drain a Graph collection by following `@odata.nextLink` verbatim. */
async function drainGraph(url: string, token: string) {
  return drainPages(async (cursor: PageCursor): Promise<HttpPage> => {
    if (cursor.kind !== 'link-header') throw new Error('unexpected cursor');
    const body = await json(await mockFetch(cursor.next, bearer(token)));
    const next = body['@odata.nextLink'];
    return { records: body.value, next: next ? { kind: 'link-header', next } : { kind: 'done' } };
  }, { kind: 'link-header', next: url });
}

/** Drain a Webex collection by following the Link HEADER - the body has no next. */
async function drainWebex(url: string) {
  return drainPages(async (cursor: PageCursor): Promise<HttpPage> => {
    if (cursor.kind !== 'link-header') throw new Error('unexpected cursor');
    const res = await mockFetch(cursor.next, bearer(DEMO_WEBEX_TOKEN));
    const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('Link') ?? '');
    return { records: (await json(res)).items, next: m ? { kind: 'link-header', next: m[1] } : { kind: 'done' } };
  }, { kind: 'link-header', next: url });
}

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

test('the directory keeps every trap the connectors must survive', () => {
  const d = directory();
  const shouty = d.people.filter((p) => /@[A-Z.]+$/.test(p.email));
  assert.equal(shouty.length, 1, 'exactly one upper-cased domain');
  assert.equal(agencyOf(shouty[0].email), shouty[0].agency, 'agency split must lower-case the domain');

  assert.ok(d.people.some((p) => agencyOf(p.email) === 'contractor'));
  assert.equal(d.people.filter((p) => p.inTeams && facilityCodeOf(p.streetAddress) === undefined).length, 3,
    'two with no LC= code and one written "LC 0412"');
  assert.equal(d.resourceAccounts.length, 2);
  // No real customer data: every address is on a reserved .example domain.
  assert.ok(d.people.every((p) => p.email.toLowerCase().endsWith('.example')));
});

// ---------------------------------------------------------------------------
// Teams / Graph
// ---------------------------------------------------------------------------

test('graph: token endpoint rejects a wrong secret, and Graph rejects a missing token', async () => {
  const bad = await mockFetch(
    'https://login.microsoftonline.com/' + directory().entraTenantId + '/oauth2/v2.0/token',
    { method: 'POST', body: 'grant_type=client_credentials&client_id=demo-client-id&client_secret=nope&scope=https://graph.microsoft.com/.default' },
  );
  assert.equal(bad.status, 401);
  assert.equal((await json(bad)).error, 'invalid_client');

  const anon = await mockFetch(GRAPH + '/users');
  assert.equal(anon.status, 401);
  assert.equal((await json(anon)).error.code, 'InvalidAuthenticationToken');
});

test('graph: /users hides streetAddress unless it is $selected', async () => {
  const token = await graphToken();
  const plain = await json(await mockFetch(GRAPH + '/users?$top=5', bearer(token)));
  assert.ok(!('streetAddress' in plain.value[0]), 'default property set has no streetAddress');

  const selected = await json(await mockFetch(GRAPH + '/users?$top=5&$select=id,streetAddress', bearer(token)));
  assert.ok('streetAddress' in selected.value[0]);
});

test('graph: userConfigurations drains to exactly the voice accounts, resource accounts included', async () => {
  const token = await graphToken();
  const d = directory();
  const drained = await drainGraph(
    GRAPH + '/admin/teams/userConfigurations?$filter=isEnterpriseVoiceEnabled eq true&$top=25', token);

  const voicePeople = d.people.filter((p) => p.teamsVoice).length;
  assert.ok(drained.pages > 1, 'must actually paginate');
  assert.equal(drained.truncated, false);
  assert.equal(drained.records.length, voicePeople + d.resourceAccounts.length);
  const ids = new Set(drained.records.map((r: any) => r.id));
  assert.equal(ids.size, drained.records.length, 'no duplicates across pages');
  assert.equal(drained.records.filter((r: any) => r.accountType === 'resourceAccount').length, 2);
});

test('graph: an unsupported $filter is a 400, never silently ignored', async () => {
  const token = await graphToken();
  const res = await mockFetch(GRAPH + "/admin/teams/userConfigurations?$filter=startswith(userPrincipalName,'a')", bearer(token));
  assert.equal(res.status, 400);
});

test('graph: the planted SBC fails most calls in the incident window, and only there', async () => {
  const token = await graphToken();
  const to = new Date(now()).toISOString();
  const from = new Date(now() - PLANTED_WINDOW_MS).toISOString();
  const drained = await drainGraph(
    GRAPH + '/communications/callRecords/getDirectRoutingCalls(fromDateTime=' + from + ',toDateTime=' + to + ')', token);

  const onTrunk = (fqdn: string) => drained.records.filter((c: any) => c.trunkFullyQualifiedDomainName === fqdn);
  const failRate = (rows: any[]) => rows.filter((c) => !c.successfulCall).length / Math.max(1, rows.length);
  assert.ok(onTrunk(TEAMS_PLANTED.failingTrunk).length > 0);
  assert.ok(failRate(onTrunk(TEAMS_PLANTED.failingTrunk)) > 0.4);
  assert.ok(failRate(drained.records.filter((c: any) => c.trunkFullyQualifiedDomainName !== TEAMS_PLANTED.failingTrunk)) < 0.2);
  assert.ok(onTrunk(TEAMS_PLANTED.failingTrunk).some((c: any) => c.finalSipCode === 503));
});

test('graph: call quality is ISO-8601 durations, reachable only through $expand', async () => {
  const token = await graphToken();
  const list = await json(await mockFetch(GRAPH + '/communications/callRecords', bearer(token)));
  const id = list.value[0].id;

  const bare = await json(await mockFetch(GRAPH + '/communications/callRecords/' + id, bearer(token)));
  assert.equal(bare.sessions, undefined);

  const full = await json(await mockFetch(
    GRAPH + '/communications/callRecords/' + id + '?$expand=sessions($expand=segments)', bearer(token)));
  const stream = full.sessions[0].segments[0].media[0].streams[0];
  assert.match(stream.averageJitter, /^PT\d+(\.\d+)?S$/);
  assert.ok(Number.isNaN(Number(stream.averageJitter)), 'Number() on it is NaN - the trap');
});

test('graph: calls from the planted facility are degraded in the incident window', async () => {
  const token = await graphToken();
  const from = new Date(now() - PLANTED_WINDOW_MS).toISOString();
  const list = await drainGraph(GRAPH + '/communications/callRecords?$filter=startDateTime ge ' + from, token);
  const byEntra = new Map(directory().people.map((p) => [p.ids.entra, p]));
  const seconds = (d: string) => Number(/^PT([\d.]+)S$/.exec(d)![1]);

  let degraded = 0;
  for (const summary of list.records as any[]) {
    const full = await json(await mockFetch(
      GRAPH + '/communications/callRecords/' + summary.id + '?$expand=sessions($expand=segments)', bearer(token)));
    const houston = full.participants_v2.some((x: any) => byEntra.get(x.id)?.facility?.code === TEAMS_PLANTED.degradedFacility);
    const stream = full.sessions[0].segments[0].media[0].streams[0];
    if (houston) {
      assert.ok(seconds(stream.averageJitter) >= 0.03, 'Houston jitter is high');
      degraded++;
    }
  }
  assert.ok(degraded >= 10);
});

test('graph: a token dies at expires_in, and the next page is a 401', async () => {
  const token = await graphToken();
  assert.equal((await mockFetch(GRAPH + '/users?$top=1', bearer(token))).status, 200);
  clock.advance(GRAPH_TOKEN_TTL_S * 1000);
  assert.equal((await mockFetch(GRAPH + '/users?$top=1', bearer(token))).status, 401);
});

// ---------------------------------------------------------------------------
// Genesys
// ---------------------------------------------------------------------------

test('genesys: pageSize over 100 is a 400, not a quiet clamp', async () => {
  const token = await genesysToken();
  const res = await mockFetch(GENESYS + '/api/v2/users?pageSize=500', bearer(token));
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'bad.request');
});

test('genesys: one-indexed pages with a RELATIVE nextUri drain every active user', async () => {
  const token = await genesysToken();
  const base = GENESYS;
  const drained = await drainPages(async (cursor): Promise<HttpPage> => {
    if (cursor.kind !== 'page') throw new Error('unexpected cursor');
    const body = await json(await mockFetch(
      base + '/api/v2/users?pageSize=' + cursor.limit + '&pageNumber=' + cursor.page, bearer(token)));
    if (body.nextUri) assert.ok(body.nextUri.startsWith('/api/v2/'), 'nextUri is relative');
    return {
      records: body.entities,
      next: body.pageNumber < body.pageCount ? { kind: 'page', page: cursor.page + 1, limit: cursor.limit } : { kind: 'done' },
    };
  }, { kind: 'page', page: 1, limit: 25 });

  const active = directory().people.filter((p) => p.inGenesys && p.genesysActive).length;
  assert.equal(drained.records.length, active);
  assert.ok(drained.pages > 1);

  const any = await json(await mockFetch(base + '/api/v2/users?state=any&pageSize=1', bearer(token)));
  assert.ok(any.total > active, 'state=any includes the inactive ones the default hides');

  const emails = drained.records.map((u: any) => u.email as string);
  assert.ok(emails.some((e) => agencyOf(e) === 'contractor'));
});

test('genesys: the planted queue is swamped - in the backlog now and in the abandon rate', async () => {
  const token = await genesysToken();
  const queues = genesysQueues();
  const planted = queues.find((q) => q.name === GENESYS_PLANTED_QUEUE)!;
  const post = (path: string, body: unknown) => mockFetch(GENESYS + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const filter = { type: 'or', predicates: queues.map((q) => ({ dimension: 'queueId', value: q.id })) };

  const obs = await json(await post('/api/v2/analytics/queues/observations/query', { filter, metrics: ['oWaiting'] }));
  const waiting = (id: string) => obs.results.find((r: any) => r.group.queueId === id).data[0].stats.count;
  assert.ok(waiting(planted.id) >= 20);
  for (const q of queues.filter((x) => x.id !== planted.id)) assert.ok(waiting(q.id) < 5);

  const interval = new Date(now() - PLANTED_WINDOW_MS).toISOString() + '/' + new Date(now()).toISOString();
  const agg = await json(await post('/api/v2/analytics/conversations/aggregates/query', {
    interval, groupBy: ['queueId'], filter, metrics: ['nOffered', 'tAbandon'],
  }));
  const abandonRate = (id: string) => {
    const metrics = agg.results.find((r: any) => r.group.queueId === id)?.data[0]?.metrics ?? [];
    const offered = metrics.find((m: any) => m.metric === 'nOffered')?.stats.count ?? 0;
    const abandoned = metrics.find((m: any) => m.metric === 'tAbandon')?.stats.count ?? 0;
    return abandoned / Math.max(1, offered);
  };
  assert.ok(abandonRate(planted.id) > 0.2);
});

// ---------------------------------------------------------------------------
// Webex
// ---------------------------------------------------------------------------

test('webex: pagination lives in the Link header only', async () => {
  const first = await mockFetch(WEBEX + '/people?max=10', bearer(DEMO_WEBEX_TOKEN));
  const body = await json(first);
  assert.deepEqual(Object.keys(body), ['items'], 'nothing in the body says there is more');
  assert.match(first.headers.get('Link') ?? '', /rel="next"/);

  const drained = await drainWebex(WEBEX + '/people?max=10&callingData=true');
  assert.equal(drained.records.length, directory().people.filter((p) => p.inWebex).length);
  // callingData=true adds locationId - except for the people with no
  // facility, whom Webex puts nowhere rather than at a default.
  const placed = drained.records.filter((p: any) => 'locationId' in p).length;
  const withFacility = directory().people.filter((p) => p.inWebex && p.facility).length;
  assert.equal(placed, withFacility);
  assert.ok(placed > 0);
});

test('webex: quality exists for meeting INSTANCES; a series id is a 404', async () => {
  const series = await json(await mockFetch(WEBEX + '/meetings?max=100', bearer(DEMO_WEBEX_TOKEN)));
  const instances = await json(await mockFetch(WEBEX + '/meetings?meetingType=meeting&max=100', bearer(DEMO_WEBEX_TOKEN)));
  assert.equal(series.items[0].meetingType, 'meetingSeries');

  const q = (id: string) => mockFetch(
    'https://analytics.webexapis.com/v1/meeting/qualities?meetingId=' + encodeURIComponent(id), bearer(DEMO_WEBEX_TOKEN));
  assert.equal((await q(series.items[0].id)).status, 404);

  // The planted meetings are the latest ones; Houston participants are degraded.
  const latest = instances.items[instances.items.length - 1];
  const quality = await json(await q(latest.id));
  const houston = quality.items.filter((p: any) =>
    directory().people.find((x) => x.email === p.webexUserEmail)?.facility?.code === TEAMS_PLANTED.degradedFacility);
  assert.ok(houston.length > 0, 'the planted meeting has a Houston participant');
  const meanLoss = (p: any) => p.audioIn[0].packetLoss.reduce((a: number, b: number) => a + b, 0) / p.audioIn[0].packetLoss.length;
  assert.ok(houston.every((p: any) => meanLoss(p) > 4));
});

test('webex: a CDR is invisible until five minutes after the call ends', async () => {
  const url = (from: number, to: number) => 'https://analytics-calling.webexapis.com/v1/cdr_feed?startTime=' +
    new Date(from).toISOString() + '&endTime=' + new Date(to).toISOString();
  const recent = await json(await mockFetch(url(now() - CDR_VISIBILITY_DELAY_MS, now()), bearer(DEMO_WEBEX_TOKEN)));
  assert.equal(recent.items.length, 0);

  const day = await drainWebex(url(now() - 24 * 3600_000, now()));
  assert.ok(day.records.length > 0);
  assert.ok(day.records.every((r: any) => Date.parse(r['Release time']) <= now() - CDR_VISIBILITY_DELAY_MS));
});

// ---------------------------------------------------------------------------
// Shared behaviour
// ---------------------------------------------------------------------------

test('an injected 429 carries Retry-After and clears after one call', async () => {
  injectFault('webex', 429);
  const limited = await mockFetch(WEBEX + '/locations', bearer(DEMO_WEBEX_TOKEN));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '2');
  assert.equal((await mockFetch(WEBEX + '/locations', bearer(DEMO_WEBEX_TOKEN))).status, 200);
});

test('anything the mock does not model is a 501 that says so, never a plausible 404', async () => {
  const path = await mockFetch(WEBEX + '/rooms', bearer(DEMO_WEBEX_TOKEN));
  assert.equal(path.status, 501);
  assert.equal((await json(path)).mock, true);

  const host = await mockFetch('https://api.mypurecloud.com/api/v2/users');
  assert.equal(host.status, 501);
});

test('the same request under the same clock returns byte-identical bodies', async () => {
  const token = await genesysToken();
  const a = await (await mockFetch(GENESYS + '/api/v2/users?pageSize=100', bearer(token))).text();
  resetMockState();
  const token2 = await genesysToken();
  const b = await (await mockFetch(GENESYS + '/api/v2/users?pageSize=100', bearer(token2))).text();
  assert.equal(a, b);
});
