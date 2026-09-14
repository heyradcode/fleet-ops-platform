/**
 * Splunk integration, pinned.
 *
 * Three of these guard mistakes that produce NO ERROR: a millisecond timestamp,
 * a JSON array instead of newline-delimited objects, and observations reaching
 * the index. All three look like success and cost the customer money.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  alarmToHec, incidentToHec, serialiseBatch, send, hecConfig, hecSent,
  resetHecSent, setHecTransport, resetHecTransport, SOURCETYPES, HEC_BATCH_SIZE,
  type HecEvent,
} from './hec.ts';
import {
  registerSplunkForwarding, flushSplunk, resetSplunkBuffer, pendingSplunkCount,
} from './forwarder.ts';
import { runSearch, setSearchTransport, resetSearchTransport, searchCatalogue } from './search.ts';
import { EventBus } from '../../aws/eventbridge.ts';
import { setClock, fixedClock } from '../../platform/clock.ts';
import type { AlarmEventDetail, IncidentEventDetail } from '../../platform/types.ts';

setClock(fixedClock());

const T = '2026-09-08T14:30:00.000Z';

// The BUS PROJECTION, not a full Alarm - because that is what a consumer
// actually receives. Typing this fixture as `Alarm` is what hid the bug: the
// test passed a field the bus never carries.
const alarm: AlarmEventDetail = {
  tenantId: 'acme-networks',
  alarmId: 'alm_1',
  deviceId: 'dev-cor-dal01-01',
  interfaceId: 'if-cor-dal01-01-1',
  siteId: 'dal-01',
  kind: 'link-down',
  severity: 'critical',
  planeCount: 2,
  raisedAt: T,
};

const incident: IncidentEventDetail = {
  tenantId: 'acme-networks',
  incidentId: 'inc_1',
  title: 'Device unreachable affecting 4 devices at dal-01',
  severity: 'critical',
  status: 'open',
  siteId: 'dal-01',
  deviceIds: ['dev-dis-dal01-03', 'dev-acc-dal01-05'],
  alarmIds: ['alm_1'],
  rootCauseDeviceId: 'dev-dis-dal01-03',
  openedAt: T,
};

// ---------------------------------------------------------------------------
// The wire format
// ---------------------------------------------------------------------------

test('time is EPOCH SECONDS, not milliseconds', () => {
  const e = alarmToHec(alarm, 'netpulse');

  // Send milliseconds and Splunk indexes this in roughly the year 56000. No
  // error, no search results, and the licence meter still runs.
  assert.equal(e.time, Date.parse(T) / 1000);
  assert.ok(e.time < 4_000_000_000, 'a millisecond timestamp would be ~1.8e12');
});

test('a batch is newline-delimited objects, NOT a JSON array', () => {
  const body = serialiseBatch([alarmToHec(alarm, 'netpulse'), incidentToHec(incident, 'netpulse')]);

  assert.ok(!body.startsWith('['), 'an array indexes the whole batch as ONE event');
  assert.equal(body.split('\n').length, 2);
  // Each line must parse on its own - that is what HEC actually reads.
  for (const line of body.split('\n')) assert.doesNotThrow(() => JSON.parse(line));
});

test('host is the DEVICE, and an incident pivots on its root cause', () => {
  // `host` is what an operator pivots on in Splunk. Filling it with the sender
  // makes every event look like it came from one machine.
  assert.equal(alarmToHec(alarm, 'netpulse').host, alarm.deviceId);
  assert.equal(incidentToHec(incident, 'netpulse').host, incident.rootCauseDeviceId);
});

test('an incident with no root cause still gets a usable host', () => {
  const vague = { ...incident, rootCauseDeviceId: undefined };
  // Two unrelated failures that merged on time and site have no single cause.
  // Falling back to the site beats emitting undefined, which Splunk would
  // index as the literal string.
  assert.equal(incidentToHec(vague, 'netpulse').host, incident.siteId);
});

test('indexed fields are few, and carry what an operator filters by', () => {
  const e = alarmToHec(alarm, 'netpulse');

  // Every indexed field costs index space on EVERY event. The payload stays
  // searchable inside `event` at no extra cost.
  assert.ok(Object.keys(e.fields).length <= 6, 'indexed fields are not free');
  assert.equal(e.fields.tenant, 'acme-networks');
  assert.equal(e.fields.site, 'dal-01');
  assert.equal(e.fields.severity, 'critical');
  // The number that explains why this alarm paged.
  assert.equal(e.fields.planes, 2);
});

test('sourcetypes are versioned, because saved searches are the customer\'s code', () => {
  assert.match(SOURCETYPES.alarm, /:v\d+$/);
  assert.match(SOURCETYPES.incident, /:v\d+$/);
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test('events are batched, not one request each', async () => {
  resetHecSent();
  resetHecTransport();

  const many: HecEvent[] = Array.from({ length: HEC_BATCH_SIZE * 2 + 5 },
    (_, i) => alarmToHec({ ...alarm, alarmId: 'alm_' + i }, 'netpulse'));

  const result = await send(many, hecConfig());

  // A cascade is a few hundred alarms. One HTTPS round trip each against a
  // token-rate-limited indexer is both slow and rude.
  assert.equal(result.batches, 3);
  assert.equal(result.events, many.length);
});

test('a Splunk outage does not fail the run, and keeps the events', async () => {
  resetHecSent();
  setHecTransport(() => Promise.reject(new Error('connection refused')));

  const result = await send([alarmToHec(alarm, 'netpulse')], hecConfig());

  // The alarms are already persisted, already on the bus, already paging.
  // Splunk is a mirror for the customer's console; a mirror being unavailable
  // is not an incident in its own right.
  assert.equal(result.events, 0);
  assert.equal(result.failed.length, 1, 'refused events come back for replay');
  resetHecTransport();
});

test('a non-zero HEC code is a failure even on a 200', async () => {
  resetHecSent();
  // HEC answers 200 with a JSON body carrying its own code. Checking the HTTP
  // status alone reports success for "Invalid token".
  setHecTransport(() => Promise.resolve({ code: 4, text: 'Invalid token' }));

  const result = await send([alarmToHec(alarm, 'netpulse')], hecConfig());
  assert.equal(result.events, 0);
  assert.equal(result.failed.length, 1);
  resetHecTransport();
});

// ---------------------------------------------------------------------------
// The bus wiring - and what is deliberately absent from it
// ---------------------------------------------------------------------------

test('Splunk subscribes to alarms and incidents', async () => {
  resetHecSent();
  resetSplunkBuffer();
  resetHecTransport();

  const local = new EventBus('test-bus');
  registerSplunkForwarding(local);

  await local.putEvents(
    { source: 'netpulse.evaluate', detailType: 'AlarmRaised', detail: alarm },
    { source: 'netpulse.detect', detailType: 'IncidentOpened', detail: incident },
  );

  assert.equal(pendingSplunkCount(), 2);
  const flushed = await flushSplunk();
  assert.equal(flushed.events, 2);
  assert.deepEqual(
    hecSent.map((e) => e.sourcetype).sort(),
    [SOURCETYPES.alarm, SOURCETYPES.incident].sort(),
  );
});

test('observations cannot reach Splunk, because they never reach the bus', async () => {
  resetHecSent();
  resetSplunkBuffer();

  const local = new EventBus('test-bus');
  registerSplunkForwarding(local);

  // Nothing in the platform publishes this detailType. Asserting it here pins
  // the claim at the Splunk boundary too: the expensive mistake is not merely
  // discouraged, there is no event for a rule to match.
  await local.putEvents({
    source: 'netpulse.evaluate', detailType: 'ObservationRecorded', detail: { deviceId: 'x' },
  });

  assert.equal(pendingSplunkCount(), 0);
});

test('Splunk is not filtered by severity, unlike the pager', async () => {
  resetHecSent();
  resetSplunkBuffer();

  const local = new EventBus('test-bus');
  registerSplunkForwarding(local);

  await local.putEvents({
    source: 'netpulse.evaluate', detailType: 'AlarmRaised',
    detail: { ...alarm, severity: 'info' },
  });

  // Waking someone is expensive, so the pager filters. A log platform's whole
  // value is having the boring events present six weeks later, and filtering
  // at write time is a decision you cannot undo.
  assert.equal(pendingSplunkCount(), 1);
});

// ---------------------------------------------------------------------------
// Searching back
// ---------------------------------------------------------------------------

test('the agent picks a catalogued search; it never composes SPL', () => {
  const names = searchCatalogue().map((s) => s.name);
  assert.ok(names.length > 0);
  assert.ok(names.includes('recent-config-changes'));
});

test('a device name cannot break out of the SPL string', async () => {
  let captured = '';
  setSearchTransport((spl) => { captured = spl; return Promise.resolve([]); });

  // SPL is not just a query language - it has commands that write
  // (`collect`, `outputlookup`) and commands that run scripts. An injected pipe
  // is code execution inside the customer's SIEM, which is the one system
  // meant to be the record of what happened.
  await runSearch({
    name: 'recent-config-changes',
    tenant: 'acme-networks',
    device: 'sw-1" | outputlookup evil.csv | search "',
    hours: 24,
  });

  // The quote is escaped, so the injected pipes stay inside the string literal.
  assert.ok(captured.includes('\\"'), 'the quote must be escaped');
  assert.ok(!/object="sw-1"\s*\|/.test(captured), 'the pipe must not escape the literal');
  resetSearchTransport();
});

test('a newline cannot start a fresh SPL command', async () => {
  let captured = '';
  setSearchTransport((spl) => { captured = spl; return Promise.resolve([]); });

  await runSearch({
    name: 'device-mentions', tenant: 'acme-networks',
    device: 'sw-1\n| delete', hours: 1,
  });

  // SPL is line-oriented. An embedded newline ends the quoted string.
  assert.ok(!captured.includes('\n'), 'newlines must be stripped from parameters');
  resetSearchTransport();
});

test('every catalogued search is scoped to the tenant', async () => {
  const seen: string[] = [];
  setSearchTransport((spl) => { seen.push(spl); return Promise.resolve([]); });

  for (const { name } of searchCatalogue()) {
    await runSearch({ name, tenant: 'acme-networks', device: 'sw-1', hours: 24 });
  }

  // Same discipline as the DynamoDB partition key: there is no code path that
  // builds a search without a tenant filter.
  assert.ok(seen.length > 0);
  for (const spl of seen) assert.ok(spl.includes('tenant="acme-networks"'), spl);
  resetSearchTransport();
});

test('an absurd time range is clamped rather than trusted', async () => {
  let captured = '';
  setSearchTransport((spl) => { captured = spl; return Promise.resolve([]); });

  // A model producing 100000 is not malicious; the cost still lands on the
  // customer's cluster.
  await runSearch({
    name: 'recent-config-changes', tenant: 'acme-networks', device: 'sw-1', hours: 100000,
  });

  assert.ok(captured.includes('earliest=-168h'), captured);
  resetSearchTransport();
});

test('a Splunk search failure degrades to no context, not a thrown turn', async () => {
  setSearchTransport(() => Promise.reject(new Error('search head unavailable')));

  const result = await runSearch({
    name: 'admin-logins', tenant: 'acme-networks', device: 'sw-1', hours: 24,
  });

  // Context is a bonus. The agent has to be able to answer without it.
  assert.deepEqual(result.rows, []);
  assert.ok(result.spl.length > 0, 'the query is still reported so a human can see what ran');
  resetSearchTransport();
});
