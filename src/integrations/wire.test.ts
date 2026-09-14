/**
 * The decoder/mapper split, pinned.
 *
 * These are the claims the architecture rests on. Each one is a thing that was
 * either wrong in the fleet build's shape or is a documented way network
 * ingestion goes quietly wrong; if you change one, change it deliberately
 * rather than making the test pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Inventory, canonicalInterfaceName } from '../platform/inventory.ts';
import { isEvent, resolveObservedAt, CLOCK_SKEW_LIMIT_MS } from '../platform/types.ts';
import type { EventObservation } from '../platform/types.ts';
import { normaliseBatch, mappers, decoders, rawKey, parseRawKey } from './wire-registry.ts';
import {
  DEVICES, INTERFACES, TENANT, syslogBatch, snmpBatch, skewedBatch,
} from './wire-fixtures.ts';

function inventory(): Inventory {
  return new Inventory(TENANT, DEVICES, INTERFACES);
}

function events(obs: ReturnType<typeof normaliseBatch>['observations']): EventObservation[] {
  return obs.filter(isEvent);
}

// ---------------------------------------------------------------------------
// The split itself
// ---------------------------------------------------------------------------

test('one syslog decoder serves all three vendors', () => {
  // The whole N + M claim in one assertion: three vendors, and exactly one
  // piece of code parses their shared framing.
  const syslogDecoders = decoders.filter((d) => d.encoding === 'syslog');
  assert.equal(syslogDecoders.length, 1);

  const syslogMappers = mappers.filter((m) => m.encoding === 'syslog');
  assert.equal(new Set(syslogMappers.map((m) => m.vendor)).size, 3);
});

test('a mixed-vendor batch normalises per record, not per file', () => {
  const { observations, stats } = normaliseBatch(syslogBatch, inventory());

  assert.equal(stats.records, 8);
  assert.equal(stats.decoded, 7);          // the truncated datagram is skipped
  assert.equal(stats.observations, 5);
  assert.equal(stats.mapperErrors, 0);

  const vendors = new Set(observations.map((o) => o.vendor));
  assert.deepEqual([...vendors].sort(), ['aruba', 'cisco', 'juniper']);
});

test('a truncated datagram costs one record, not the batch', () => {
  const { stats } = normaliseBatch(syslogBatch, inventory());
  // 8 in, 7 decoded, and the 7 all went somewhere accountable.
  assert.equal(stats.decoded + 1, stats.records);
  assert.equal(
    stats.observations + stats.unresolvedHost + stats.unclaimed + stats.noMapper >= stats.decoded,
    true,
  );
});

// ---------------------------------------------------------------------------
// Identity: the part that actually breaks
// ---------------------------------------------------------------------------

test('one device resolves from all three of the names it is known by', () => {
  const inv = inventory();
  const expected = 'dev-core-dal-01';

  assert.equal(inv.resolveDevice('core-sw-dal-01'), expected);
  assert.equal(inv.resolveDevice('core-sw-dal-01.acme.internal'), expected);
  assert.equal(inv.resolveDevice('10.12.0.4'), expected);
  // Syslog and SNMP routinely disagree about case for the same box.
  assert.equal(inv.resolveDevice('CORE-SW-DAL-01'), expected);
});

test('a name claimed by two devices resolves to neither', () => {
  // Guessing here attributes telemetry to the wrong box, which is worse than
  // dropping it: it is wrong and it looks fine.
  const clashing = [
    ...DEVICES,
    {
      ...DEVICES[2],
      deviceId: 'dev-acc-dal-08',
      aliases: [{ kind: 'syslog-hostname' as const, value: 'acc-sw-dal-07' }],
    },
  ];
  const inv = new Inventory(TENANT, clashing, INTERFACES);

  assert.equal(inv.resolveDevice('acc-sw-dal-07'), undefined);
  assert.equal(inv.ambiguousAliases.includes('acc-sw-dal-07'), true);
});

test('Cisco abbreviations expand, so syslog and SNMP land on one interface', () => {
  assert.equal(canonicalInterfaceName('cisco', 'Gi1/0/1'), 'GigabitEthernet1/0/1');
  assert.equal(canonicalInterfaceName('cisco', 'Te1/1/4'), 'TenGigabitEthernet1/1/4');
  assert.equal(canonicalInterfaceName('cisco', 'Po12'), 'Port-channel12');
  // Already long: expansion must be idempotent, or the second pass mangles it.
  assert.equal(canonicalInterfaceName('cisco', 'GigabitEthernet1/0/1'), 'GigabitEthernet1/0/1');
  // Other vendors are already canonical and must be left alone.
  assert.equal(canonicalInterfaceName('juniper', 'ge-0/0/1'), 'ge-0/0/1');
  assert.equal(canonicalInterfaceName('aruba', '1/1/1'), '1/1/1');
});

test('an unstable ifIndex is never used as an identity', () => {
  const inv = inventory();

  // The core switch has ifIndex persistence configured, so the index resolves.
  assert.equal(
    inv.resolveInterface('dev-core-dal-01', { ifIndex: 10001 }),
    'if-core-dal-01-gi1-0-1',
  );

  // The edge router does not. Its index is recorded, arrives in every trap, and
  // is deliberately not resolvable - a reload renumbers it, and the counters
  // would silently continue against a different cable.
  assert.equal(inv.resolveInterface('dev-edge-aus-01', { ifIndex: 528 }), undefined);
  assert.equal(
    inv.resolveInterface('dev-edge-aus-01', { name: 'ge-0/0/1' }),
    'if-edge-aus-01-ge-0-0-1',
  );
});

test('an unknown device is counted and named, never dropped in silence', () => {
  const { stats, unresolvedHosts } = normaliseBatch(syslogBatch, inventory());

  assert.equal(stats.unresolvedHost, 1);
  assert.deepEqual(unresolvedHosts, ['rogue-sw-99']);
});

// ---------------------------------------------------------------------------
// What each mapper is actually for
// ---------------------------------------------------------------------------

test('Junos reads structured data; Cisco scrapes prose; both reach the same shape', () => {
  const { observations } = normaliseBatch(syslogBatch, inventory());

  const junos = events(observations).find((o) => o.vendor === 'juniper');
  assert.ok(junos);
  assert.equal(junos.kind, 'link-state');
  assert.equal(junos.state, 'down');
  // Resolved from the ifName SD field, not from the message text.
  assert.equal(junos.interfaceId, 'if-edge-aus-01-ge-0-0-1');
  assert.equal(junos.attributes.adminStatus, 'up');

  const cisco = events(observations).find(
    (o) => o.vendor === 'cisco' && o.attributes.layer === 'physical' && o.state === 'down',
  );
  assert.ok(cisco);
  assert.equal(cisco.interfaceId, 'if-core-dal-01-gi1-0-1');
});

test('the abbreviated 3164 line resolves to the same interface as the long 5424 one', () => {
  const { observations } = normaliseBatch(syslogBatch, inventory());

  const ciscoLinks = events(observations).filter(
    (o) => o.vendor === 'cisco' && o.kind === 'link-state' && o.state === 'down',
  );
  // %LINK (physical) and %LINEPROTO (protocol), one written `GigabitEthernet1/0/1`
  // and the other `Gi1/0/1`.
  assert.equal(ciscoLinks.length, 2);
  assert.equal(new Set(ciscoLinks.map((o) => o.interfaceId)).size, 1);
  assert.deepEqual(
    ciscoLinks.map((o) => o.attributes.layer).sort(),
    ['physical', 'protocol'],
  );
});

test('Aruba is claimed by its daemon, not by an invented event id', () => {
  const { observations } = normaliseBatch(syslogBatch, inventory());

  const aruba = events(observations).find((o) => o.vendor === 'aruba');
  assert.ok(aruba);
  assert.equal(aruba.kind, 'link-state');
  assert.equal(aruba.state, 'down');
  assert.equal(aruba.interfaceId, 'if-acc-dal-07-1-1-1');
  assert.equal(aruba.attributes.daemon, 'ops-switchd');
});

test('a message no mapper handles is unclaimed, which is the normal outcome', () => {
  const { stats } = normaliseBatch(syslogBatch, inventory());
  assert.equal(stats.unclaimed, 1);
});

// ---------------------------------------------------------------------------
// The two invariants this design exists to protect
// ---------------------------------------------------------------------------

test('severity is derived, never taken from the vendor', () => {
  const { observations } = normaliseBatch(syslogBatch, inventory());

  const up = events(observations).find((o) => o.kind === 'link-state' && o.state === 'up');
  assert.ok(up);
  // Cisco stamped syslog severity 3 - "error" - on a link coming back up, which
  // is exactly why a cross-vendor board cannot be built on the vendor's number.
  assert.equal(up.attributes.tag, 'LINK-3-UPDOWN');
  assert.equal(up.severity, 'info');

  const down = events(observations).find(
    (o) => o.kind === 'link-state' && o.state === 'down' && o.vendor === 'cisco',
  );
  assert.equal(down?.severity, 'critical');
});

test('the same failure on two feeds collapses to one dedupe key', () => {
  const inv = inventory();
  const fromSyslog = events(normaliseBatch(syslogBatch, inv).observations)
    .find((o) => o.vendor === 'cisco' && o.state === 'down' && o.attributes.layer === 'physical');
  const fromTrap = events(normaliseBatch(snmpBatch, inv).observations)[0];

  assert.ok(fromSyslog);
  assert.ok(fromTrap);

  // Different encodings, different ids, different source records - one event.
  assert.notEqual(fromSyslog.observationId, fromTrap.observationId);
  assert.equal(fromSyslog.encoding, 'syslog');
  assert.equal(fromTrap.encoding, 'snmp-trap');
  assert.equal(fromSyslog.dedupeKey, fromTrap.dedupeKey);
});

test('the vendor of a generic SNMP trap comes from the inventory, not the record', () => {
  // 1.3.6.1.6.3.1.1.5.3 is the standard SNMPv2-MIB linkDown. There is nothing
  // Cisco-shaped anywhere in that record; we know the vendor because we know
  // what we deployed.
  const raw = JSON.stringify(snmpBatch.records[0]);
  assert.equal(raw.toLowerCase().includes('cisco'), false);

  const obs = normaliseBatch(snmpBatch, inventory()).observations;
  assert.equal(obs.length, 1);
  assert.equal(obs[0].vendor, 'cisco');
  assert.equal(obs[0].platform, 'ios-xe');
});

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

test('a device clock inside the limit is trusted; outside it is not', () => {
  const near = resolveObservedAt('2026-09-08T14:30:02.400Z', '2026-09-08T14:30:02.123Z');
  assert.equal(near.observedAt, '2026-09-08T14:30:02.123Z');

  const far = resolveObservedAt('2026-09-08T14:30:02.400Z', '2026-08-08T09:15:00.000Z');
  assert.equal(far.observedAt, '2026-09-08T14:30:02.400Z');
  assert.equal(far.deviceTime, '2026-08-08T09:15:00.000Z');
  assert.equal(Math.abs(far.clockSkewMs ?? 0) > CLOCK_SKEW_LIMIT_MS, true);

  // A clock in the FUTURE is just as wrong, and a mis-set year gets there easily.
  const ahead = resolveObservedAt('2026-09-08T14:30:02.400Z', '2027-09-08T14:30:02.400Z');
  assert.equal(ahead.observedAt, '2026-09-08T14:30:02.400Z');
});

test('a month-out device still produces an observation, filed at arrival time', () => {
  const obs = events(normaliseBatch(skewedBatch, inventory()).observations);
  assert.equal(obs.length, 1);
  // The record is kept - dropping it would lose a real link failure - but it is
  // windowed by when we received it, so correlation can still see it.
  assert.equal(obs[0].observedAt, '2026-09-08T14:30:02.400Z');
  assert.equal(obs[0].deviceTime, '2026-08-08T09:15:00.000Z');
  assert.ok((obs[0].clockSkewMs ?? 0) < -CLOCK_SKEW_LIMIT_MS);
});

test('an id is a content hash, so a replayed datagram overwrites itself', () => {
  const inv = inventory();
  const first = normaliseBatch(syslogBatch, inv).observations;
  const second = normaliseBatch(syslogBatch, inv).observations;

  assert.deepEqual(
    first.map((o) => o.observationId),
    second.map((o) => o.observationId),
  );
});

// ---------------------------------------------------------------------------
// The landing zone
// ---------------------------------------------------------------------------

test('the S3 key carries enough to pick a decoder without opening the object', () => {
  const key = rawKey({
    tenantId: TENANT, vendorHint: 'cisco', encoding: 'syslog',
    receivedAt: '2026-09-08T14:30:02.400Z', objectId: 'abc123',
  });

  assert.equal(
    key,
    'raw/tenant=acme-networks/vendor=cisco/encoding=syslog/dt=2026-09-08/hh=14/abc123.json',
  );

  const parts = parseRawKey(key);
  assert.equal(parts.encoding, 'syslog');
  assert.equal(parts.tenant, TENANT);
  assert.equal(parts.dt, '2026-09-08');
});
