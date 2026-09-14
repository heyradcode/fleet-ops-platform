/**
 * The cloud HTTP layer, pinned.
 *
 * These replaced the decoder/mapper tests when the UDP feeds went away. The
 * failure modes moved with the transport: nothing here can be broken by a bad
 * regex any more, and everything here can be broken by an off-by-one in a
 * cursor - which does not throw, it silently returns a shorter estate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  drainPages, sinceFor, setWatermark, getWatermark, resetWatermarks,
  MAX_PAGES_PER_RUN, WATERMARK_OVERLAP_MS, type HttpPage, type PageCursor,
} from './http.ts';
import { verifyWebhook, signWebhook, REPLAY_WINDOW_MS } from './webhook.ts';
import { pageOf, PAGE_SIZE } from './controller/fixtures.ts';
import { connectors } from './controller/registry.ts';
import { setClock, fixedClock, now } from '../platform/clock.ts';

setClock(fixedClock());

const TENANT = 'acme-networks';
const SECRET = 'demo-only-not-a-real-webhook-secret';

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('every pagination dialect drains to the same complete set', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: i }));

  const starts: PageCursor[] = [
    { kind: 'link-header', next: '/first' },
    { kind: 'page', page: 1, limit: PAGE_SIZE },
    { kind: 'offset', offset: 0, limit: PAGE_SIZE },
  ];

  for (const start of starts) {
    const drained = await drainPages((c) => Promise.resolve(pageOf(rows, c)), start);
    // SEVEN rows, not six and not a multiple of the page size. A fixture that
    // divides evenly hides the off-by-one on the final page, which is the one
    // that actually goes wrong.
    assert.equal(drained.records.length, 7, start.kind + ' lost rows');
    assert.equal(drained.truncated, false);
  }
});

test('Mist pages are ONE-indexed, and page 1 is the first page', async () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: i }));

  const first = pageOf(rows, { kind: 'page', page: 1, limit: PAGE_SIZE });
  // Treating page 1 as offset PAGE_SIZE is the off-by-one that silently drops
  // the first page of every estate - and returns a plausible-looking result.
  assert.deepEqual(first.records, [{ id: 0 }, { id: 1 }]);
});

test('a cursor that does not advance stops rather than spinning', async () => {
  let calls = 0;
  const stuck = (): Promise<HttpPage> => {
    calls++;
    // A vendor bug, or ours. Either way the next iteration would re-fetch the
    // same page against a rate-limited API for the full Lambda timeout.
    return Promise.resolve({ records: [{ id: calls }], next: { kind: 'offset', offset: 0, limit: 2 } });
  };

  const drained = await drainPages(stuck, { kind: 'offset', offset: 0, limit: 2 });
  assert.equal(calls, 1);
  assert.equal(drained.records.length, 1);
});

test('pagination is bounded, and says so when it stops early', async () => {
  let n = 0;
  const endless = (): Promise<HttpPage> => {
    n++;
    return Promise.resolve({ records: [{ id: n }], next: { kind: 'offset', offset: n, limit: 1 } });
  };

  const drained = await drainPages(endless, { kind: 'offset', offset: 0, limit: 1 });
  assert.equal(drained.pages, MAX_PAGES_PER_RUN);
  // TRUNCATED MUST BE VISIBLE. A partial estate you know about beats a complete
  // one you never finish fetching, but only if somebody is told.
  assert.equal(drained.truncated, true);
});

test('each connector declares a pagination dialect that actually works', async () => {
  for (const c of connectors) {
    for (const r of c.resources) {
      const ctx = { tenantId: TENANT, secrets: {}, since: new Date(0) };
      const drained = await drainPages((cursor) => r.fetchPage(ctx, cursor), r.firstPage(ctx));
      assert.ok(drained.records.length > 0, c.controller + '/' + r.name + ' returned nothing');
      assert.equal(drained.truncated, false);
    }
  }
});

// ---------------------------------------------------------------------------
// Watermarks
// ---------------------------------------------------------------------------

test('the watermark overlaps rather than abutting', () => {
  resetWatermarks();
  const through = '2026-09-08T14:30:00.000Z';
  setWatermark({ tenantId: TENANT, controller: 'meraki', resource: 'device-events', through });

  const since = sinceFor(getWatermark(TENANT, 'meraki', 'device-events'), new Date(0));

  // Cloud APIs are eventually consistent: an event stamped 14:03:59 can become
  // visible at 14:04:30. Ask for exactly the watermark and that event falls in
  // the gap between two polls and is never returned to anyone, ever.
  assert.equal(Date.parse(through) - since.getTime(), WATERMARK_OVERLAP_MS);
});

test('no watermark falls back rather than fetching from the epoch', () => {
  resetWatermarks();
  const fallback = new Date('2026-09-08T14:00:00.000Z');
  assert.equal(sinceFor(undefined, fallback).getTime(), fallback.getTime());

  // A corrupt watermark must not become "since 1970" and re-ingest history.
  const corrupt = { tenantId: TENANT, controller: 'meraki', resource: 'x', through: 'not-a-date' };
  assert.equal(sinceFor(corrupt, fallback).getTime(), fallback.getTime());
});

test('watermarks are per resource, not per controller', () => {
  resetWatermarks();
  setWatermark({
    tenantId: TENANT, controller: 'meraki', resource: 'device-events',
    through: '2026-09-08T14:30:00.000Z',
  });

  // One cloud has endpoints that move at very different rates - a device list
  // changes hourly, an event feed constantly. Sharing one watermark means the
  // slow endpoint drags the fast one backwards on every poll.
  assert.ok(getWatermark(TENANT, 'meraki', 'device-events'));
  assert.equal(getWatermark(TENANT, 'meraki', 'device-statuses'), undefined);
  assert.equal(getWatermark('other-tenant', 'meraki', 'device-events'), undefined);
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const body = JSON.stringify({ alertType: 'port_down', deviceSerial: 'SNDAL010005' });

test('a genuine delivery is accepted and unwrapped', () => {
  const verdict = verifyWebhook('meraki',
    { body, headers: signWebhook('meraki', body, SECRET, now()) }, SECRET, TENANT);

  assert.ok(verdict.ok);
  assert.equal(verdict.batch.encoding, 'webhook');
  assert.equal(verdict.batch.records.length, 1);
});

test('a forged signature is refused', () => {
  const verdict = verifyWebhook('meraki', {
    body,
    headers: { 'x-cisco-meraki-signature': 'deadbeef', 'x-cisco-meraki-timestamp': String(now()) },
  }, SECRET, TENANT);

  // The endpoint is on the public internet and its URL is not a secret. Without
  // this check anyone who learns the URL can inject alarms - or inject a
  // link-UP and clear a real incident.
  assert.ok(!verdict.ok);
  assert.equal(verdict.status, 401);
});

test('a captured delivery cannot be replayed forever', () => {
  const stale = now() - (REPLAY_WINDOW_MS + 60_000);
  const verdict = verifyWebhook('meraki',
    { body, headers: signWebhook('meraki', body, SECRET, stale) }, SECRET, TENANT);

  // A valid signature stays valid indefinitely. Only a SIGNED timestamp,
  // checked against now, bounds that.
  assert.ok(!verdict.ok);
  assert.equal(verdict.status, 408);
});

test('the timestamp is inside the signed payload, so it cannot be edited', () => {
  const headers = signWebhook('meraki', body, SECRET, now() - (REPLAY_WINDOW_MS + 60_000));
  // An attacker replays the captured body and signature but rewrites the clock
  // to something current. If the timestamp were not signed, this would pass.
  headers['x-cisco-meraki-timestamp'] = String(now());

  const verdict = verifyWebhook('meraki', { body, headers }, SECRET, TENANT);
  assert.ok(!verdict.ok);
  assert.equal(verdict.status, 401, 'editing the timestamp must break the signature');
});

test('a body altered in flight is refused', () => {
  const headers = signWebhook('meraki', body, SECRET, now());
  const tampered = body.replace('port_down', 'port_up');

  // The interesting direction: flipping a down to an up would CLEAR a real
  // incident, which is worse than raising a false one.
  const verdict = verifyWebhook('meraki', { body: tampered, headers }, SECRET, TENANT);
  assert.ok(!verdict.ok);
});

test('an unknown controller is refused before any crypto runs', () => {
  const verdict = verifyWebhook('not-a-vendor', { body, headers: {} }, SECRET, TENANT);
  assert.ok(!verdict.ok);
  assert.equal(verdict.status, 400);
});

test('a valid signature over non-JSON is refused, not thrown on', () => {
  const junk = 'not json at all';
  const verdict = verifyWebhook('meraki',
    { body: junk, headers: signWebhook('meraki', junk, SECRET, now()) }, SECRET, TENANT);

  assert.ok(!verdict.ok);
  assert.equal(verdict.status, 400);
});

// ---------------------------------------------------------------------------
// The plane rule
// ---------------------------------------------------------------------------

test('one cloud declares more than one plane', () => {
  const meraki = connectors.find((c) => c.controller === 'meraki')!;
  const planes = new Set(meraki.resources.map((r) => r.plane));

  // THE WHOLE POINT of dropping planeFor(encoding). Both endpoints are
  // rest-json over one API key; if the plane came from the transport they
  // would be identical, corroboration would be unsatisfiable from vendor data,
  // and every alarm in the estate would be held back as uncorroborated.
  assert.ok(planes.size > 1, 'Meraki must observe from more than one vantage point');
  assert.ok(planes.has('device'));
  assert.ok(planes.has('controller'));
});

test('every resource declares a plane explicitly', () => {
  for (const c of connectors) {
    for (const r of c.resources) {
      assert.ok(
        ['device', 'controller', 'external'].includes(r.plane),
        c.controller + '/' + r.name + ' has no plane',
      );
    }
  }
});
