/**
 * The operations board.
 *
 * One screen, three panes: what is out there (estate), where it is (map), and
 * what needs a decision (feed). An operator watches this for a shift, so the
 * layout does not move and nothing animates that does not carry meaning.
 *
 * The one thing that DOES move is health. State replays from the recorded
 * half-hour on a coarse tick - the same cadence a real client polls at, because
 * pushing tens of thousands of records a second would be useless to a human and
 * ruinous to pay for. Alarms, by contrast, arrive on the push channel the moment
 * the rules raise them. That asymmetry is the architecture, and the board shows
 * it rather than describing it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SiteMap, type BasemapMode } from './SiteMap.tsx';
import { DevicePanel } from './DevicePanel.tsx';
import { inProcessTransport } from './transport/in-process.ts';
import { SignIn } from './SignIn.tsx';
import { useRestoredSession } from './auth/useSession.ts';
import { auth } from './auth/provider.ts';
import {
  UTILISATION_MAX, formatPercent, loadLevel, roleLabel, statusRank, witness,
  type LoadLevel,
} from './format.ts';
import type { Session } from './auth/index.ts';
import type {
  Alarm, BoardSnapshot, DeviceState, HealthTick,
} from './transport/index.ts';

/**
 * The shell. Sign-in gates everything, so there is no render path that reads
 * estate data without a verified token behind it. The transport learns about
 * the session inside useRestoredSession, synchronously, BEFORE React does -
 * see that file for why the order matters.
 */
export function App() {
  const [session, setSession, restoreError] = useRestoredSession();

  if (!session) return <SignIn onSignedIn={setSession} initialError={restoreError} />;

  return (
    <Board
      key={session.principal.sub}
      session={session}
      onSignOut={() => { auth.signOut(); setSession(null); }}
    />
  );
}

function Board({ session, onSignOut }: { session: Session; onSignOut(): void }) {
  const scope = session.principal.scope;

  // An operator opens on their own site and has no other option. An ops lead
  // opens estate-wide. The board does not offer what the token forbids -
  // showing tabs that return nothing would read as a bug rather than a rule.
  const [siteId, setSiteId] = useState<string | undefined>(
    scope.kind === 'site' ? scope.siteId : undefined,
  );
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [live, setLive] = useState<Alarm[]>([]);
  const [tick, setTick] = useState<HealthTick | null>(null);
  const [basemap, setBasemap] = useState<BasemapMode | undefined>();
  const [basemapActual, setBasemapActual] = useState<BasemapMode>('canvas');

  // --- Snapshot ------------------------------------------------------------
  useEffect(() => {
    let stale = false;
    setLive([]);
    setTick(null);
    inProcessTransport.loadBoard(siteId).then((snapshot) => {
      if (!stale) setBoard(snapshot);
    });
    return () => { stale = true; };
  }, [siteId]);

  // --- Health: polled cadence, replayed from the recording ------------------
  useEffect(
    () => inProcessTransport.subscribeHealth(siteId, setTick),
    [siteId],
  );

  // --- Alarms: the push channel. Only these are pushed, never observations.
  useEffect(() => {
    return inProcessTransport.subscribeAlarms(siteId, (alarm) => {
      setLive((prev) => (prev.some((a) => a.alarmId === alarm.alarmId)
        ? prev
        : [alarm, ...prev].slice(0, 40)));
    });
  }, [siteId]);

  // The estate as it is NOW: the snapshot's inventory, with each device's
  // status taken from the latest frame. The snapshot is the source of truth for
  // what exists; the frame is only ever a status.
  const devices = useMemo<DeviceState[]>(() => {
    const base = board?.devices ?? [];
    if (!tick) return base;
    return base.map((d) => {
      const s = tick.status.get(d.deviceId);
      return s ? { ...d, status: s } : d;
    });
  }, [board, tick]);

  const byId = useMemo(
    () => new Map(devices.map((d) => [d.deviceId, d])),
    [devices],
  );

  const flagged = useMemo(() => {
    const ids = new Set<string>();
    for (const i of board?.incidents ?? []) for (const d of i.deviceIds) ids.add(d);
    return ids;
  }, [board]);

  const pagedSet = useMemo(
    () => new Set(board?.incidents.flatMap((i) => i.alarmIds) ?? []),
    [board],
  );

  // The feed: what the rules raised in the snapshot, plus whatever has arrived
  // live since. Live arrivals are marked, so the push channel is visible as a
  // thing that happens rather than a count in a corner.
  const liveIds = useMemo(() => new Set(live.map((a) => a.alarmId)), [live]);
  const feed = useMemo(() => {
    const byAlarmId = new Map<string, Alarm>();
    for (const a of board?.alarms ?? []) byAlarmId.set(a.alarmId, a);
    for (const a of live) byAlarmId.set(a.alarmId, a);
    return [...byAlarmId.values()].sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt));
  }, [board, live]);

  // Which tabs this token permits. Tenant scope sees all of them; a site
  // operator sees exactly one, so the row becomes a label rather than a control
  // - which is the honest rendering of a permission. Device scope sees none:
  // one box is not a site, and five tabs that each return nothing would read as
  // a bug rather than a rule.
  const allSites = board?.sites ?? [];
  const visibleSites = scope.kind === 'site'
    ? allSites.filter((s) => s.siteId === scope.siteId)
    : scope.kind === 'device' ? [] : allSites;
  const canSeeAll = scope.kind === 'tenant' || scope.kind === 'region';

  const criticalCount = board?.incidents.filter((i) => i.severity === 'critical').length ?? 0;
  const heldCount = board?.heldBack.length ?? 0;

  const selectedDevice = selected ? byId.get(selected) : undefined;
  const selectedAlarms = feed.filter((a) => a.deviceId === selected);

  // The uplink chain and the blast radius, computed from the denormalised
  // uplink on each hot item. No extra round trip, and no second source of truth
  // about the topology.
  const upstream = useMemo(
    () => (selectedDevice ? chainUp(selectedDevice, byId) : []),
    [selectedDevice, byId],
  );
  const downstream = useMemo(
    () => (selectedDevice ? subtree(selectedDevice.deviceId, devices) : []),
    [selectedDevice, devices],
  );

  const unhealthy = devices.filter((d) => d.status !== 'healthy').length;

  // Worst first. An operator opens this board to find what is broken, and an
  // alphabetical list of forty healthy access points buries it.
  const ordered = useMemo(
    () => [...devices].sort((a, b) =>
      statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name)),
    [devices],
  );

  return (
    <div className="shell">
      <header className="statusbar">
        <div className="brand">
          <span className="brand-mark">NETPULSE</span>
          <span className="brand-rule" />
        </div>

        <nav className="districts" aria-label="Site">
          {visibleSites.map((s) => (
            <button
              key={s.siteId}
              className="district"
              title={s.name}
              aria-pressed={siteId === s.siteId}
              onClick={() => { setSiteId(s.siteId); setSelected(undefined); }}
            >
              {s.siteId}
              {siteId === s.siteId && <span className="count">{devices.length}</span>}
            </button>
          ))}
          {/* Not a sixth site - a different ROLE, and only offered to a token
              that carries it. */}
          {canSeeAll && (
            <button
              className="district is-lead"
              aria-pressed={siteId === undefined}
              onClick={() => { setSiteId(undefined); setSelected(undefined); }}
              title="Estate-wide scope, granted by the admin role"
            >
              all
            </button>
          )}
        </nav>

        <div className="statusbar-spacer" />

        <div className={`tally ${criticalCount > 0 ? 'is-critical' : ''}`}>
          <span className="n">{board?.incidents.length ?? 0}</span> incidents
        </div>
        <div className="tally is-warning">
          <span className="n">{heldCount}</span> held
        </div>

        {/* The clock follows the replay, so what the board shows and what time
            it claims to be cannot disagree. */}
        <div className="clock" title="Replaying the recorded half-hour">
          <span className="pulse" aria-hidden="true" />
          <span>{tick ? tick.at.slice(11, 19) + 'Z' : '--:--:--'}</span>
          {tick && (
            <span className="replay" aria-label="Replay progress">
              <span className="replay-fill" style={{ width: `${((tick.index + 1) / tick.total) * 100}%` }} />
            </span>
          )}
        </div>

        <div className="whoami">
          <span className="whoami-email mono">{session.principal.email}</span>
          <span className="whoami-scope">{describeScope(scope)}</span>
        </div>
        <button className="signout" onClick={onSignOut}>Sign out</button>
      </header>

      <div className={`body ${selectedDevice ? 'has-panel' : ''}`}>
        <aside className="roster">
          <div className="pane-head">
            <span>Estate</span>
            <span className="mono">
              <span className="roster-moving">{unhealthy}</span> / {devices.length}
            </span>
          </div>
          <div className="roster-list">
            {ordered.map((d) => (
              <DeviceRow
                key={d.deviceId}
                device={d}
                flagged={flagged.has(d.deviceId)}
                selected={selected === d.deviceId}
                onSelect={() => setSelected(d.deviceId)}
              />
            ))}
            {devices.length === 0 && board && (
              <p className="empty">No devices in scope at this site.</p>
            )}
            {!board && <p className="empty">Loading the estate…</p>}
          </div>
        </aside>

        <main className="stage">
          <div className="map-wrap">
            <SiteMap
              sites={allSites}
              devices={devices}
              selectedSiteId={selectedDevice?.siteId ?? siteId}
              onSelectSite={(id) => { if (!siteId) setSiteId(id); }}
              basemap={basemap}
              onBasemap={setBasemapActual}
            />

            <div className="legend">
              <div className="legend-row">
                <span className="legend-dot" style={{ background: 'var(--healthy)' }} /> healthy
              </div>
              <div className="legend-row">
                <span className="legend-dot" style={{ background: 'var(--degraded)' }} /> degraded
              </div>
              <div className="legend-row">
                <span className="legend-dot" style={{ background: 'var(--down)' }} /> down
              </div>
              <div className="legend-row">
                <span className="legend-halo" /> incident
              </div>
              <div className="legend-note">circle size = devices at site</div>

              {/* The basemap is a network resource and this board runs offline,
                  so the fallback is a first-class mode rather than a failure. */}
              <button
                className="legend-toggle"
                onClick={() => setBasemap(basemapActual === 'streets' ? 'canvas' : 'streets')}
                title={basemapActual === 'streets'
                  ? 'Streets from OpenFreeMap. Switch to the plain canvas.'
                  : 'Plain canvas. Switch to streets (needs network).'}
              >
                <span className={`legend-mode is-${basemapActual}`} />
                {basemapActual === 'streets' ? 'streets' : 'canvas'}
              </button>
            </div>

            <p className="scale-note">
              <b>{devices.length}</b> devices, <b>{unhealthy}</b> not healthy.{' '}
              {live.length > 0
                ? <><b>{live.length}</b> live {live.length === 1 ? 'alarm' : 'alarms'} pushed.</>
                : 'Nothing pushed yet.'}
              <br />
              <span className="scale-sub">Health polls every tick. Only alarms are pushed.</span>
            </p>
          </div>

          <section className="feed">
            <div className="pane-head">
              <span>Alarms</span>
              <span className="mono">
                {live.length > 0 && <span className="feed-live">{live.length} live</span>}
                {feed.length}
              </span>
            </div>
            <div className="feed-list">
              {feed.map((a) => (
                <AlarmRow
                  key={a.alarmId}
                  alarm={a}
                  name={byId.get(a.deviceId)?.name ?? a.deviceId}
                  paged={pagedSet.has(a.alarmId)}
                  live={liveIds.has(a.alarmId)}
                  onSelect={() => setSelected(a.deviceId)}
                />
              ))}
              {feed.length === 0 && board && (
                <p className="empty">Nothing raised at this site. Quiet is the goal.</p>
              )}
            </div>
          </section>
        </main>

        {selectedDevice && (
          <DevicePanel
            key={selectedDevice.deviceId}
            device={selectedDevice}
            alarms={selectedAlarms}
            paged={pagedSet}
            upstream={upstream}
            downstream={downstream}
            onSelect={setSelected}
            onClose={() => setSelected(undefined)}
          />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function DeviceRow({ device, flagged, selected, onSelect }: {
  device: DeviceState;
  flagged: boolean;
  selected: boolean;
  onSelect(): void;
}) {
  const level = loadLevel(device.cpuUtilisation);
  const row = useRef<HTMLButtonElement>(null);

  // The other direction: a device selected from the panel's topology chain may
  // be forty entries down. Bring it into view, without yanking the list if it
  // is already visible.
  useEffect(() => {
    if (selected) row.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <button ref={row} className="driver" aria-selected={selected} onClick={onSelect}>
      <span className={`status-bar status-${device.status}`} aria-hidden="true" />

      <span className="driver-who">
        <span className="driver-id">{roleLabel(device.role)}</span>
        <span className="driver-name">{device.name}</span>
      </span>

      <span className="hos">
        {flagged && <span className="driver-flag is-critical">ALM</span>}
        {device.interfacesDown > 0 && (
          <span className="ports-down" title={device.interfacesDown + ' interfaces down'}>
            {device.interfacesDown}↓
          </span>
        )}
        <UtilisationStrip percent={device.cpuUtilisation} level={level} />
        <span className={`hos-clock ${level ? `is-${level}` : ''}`}>
          {formatPercent(device.cpuUtilisation)}
        </span>
      </span>
    </button>
  );
}

/**
 * The utilisation strip.
 *
 * A miniature of the load graph every network engineer reads daily: a ruled
 * bar filled to current utilisation. The fill turns amber then red at exactly
 * the thresholds the capacity rule uses, so the strip and the alarm are reading
 * the same number and cannot disagree.
 */
function UtilisationStrip({ percent, level }: { percent: number; level: LoadLevel }) {
  const pct = Math.max(0, Math.min(100, (percent / UTILISATION_MAX) * 100));
  return (
    <span
      className="hos-strip"
      role="meter"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={UTILISATION_MAX}
      aria-label={`${formatPercent(percent)} utilisation`}
    >
      <span className={`hos-fill ${level ? `is-${level}` : ''}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function AlarmRow({ alarm, name, paged, live, onSelect }: {
  alarm: Alarm;
  name: string;
  paged: boolean;
  live: boolean;
  onSelect(): void;
}) {
  return (
    <button
      className={`exception ${paged ? '' : 'is-noise'} ${live ? 'is-live' : ''}`}
      onClick={onSelect}
    >
      <span className="exception-time">{alarm.raisedAt.slice(11, 19)}</span>
      <span className="exception-kind">{alarm.kind.replace(/-/g, ' ')}</span>
      <span className="exception-detail">
        <b>{name}</b>
        {' · '}
        {witness(alarm, paged)}
      </span>
      <span className={`verdict ${paged ? 'is-paged' : 'is-held'}`}>
        {paged ? 'PAGED' : 'HELD'}
      </span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Walk up the uplink chain, nearest first.
 *
 * Bounded rather than recursive without a limit: a mis-discovered LLDP loop is
 * a real thing, and without the visited set this would hang the tab.
 */
function chainUp(device: DeviceState, byId: Map<string, DeviceState>): DeviceState[] {
  const out: DeviceState[] = [];
  const seen = new Set<string>([device.deviceId]);
  let current = device.uplinkDeviceId;

  while (current && out.length < 8 && !seen.has(current)) {
    const next = byId.get(current);
    if (!next) break;
    out.push(next);
    seen.add(current);
    current = next.uplinkDeviceId;
  }
  return out;
}

/** Everything that depends on this device, at any depth. */
function subtree(deviceId: string, devices: DeviceState[]): DeviceState[] {
  const out: DeviceState[] = [];
  let frontier = new Set<string>([deviceId]);
  const seen = new Set<string>([deviceId]);

  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const d of devices) {
      if (!d.uplinkDeviceId || seen.has(d.deviceId)) continue;
      if (!frontier.has(d.uplinkDeviceId)) continue;
      seen.add(d.deviceId);
      out.push(d);
      next.add(d.deviceId);
    }
    frontier = next;
  }
  return out;
}

/** The caller's reach, in the words an operator would use. */
function describeScope(scope: Session['principal']['scope']): string {
  switch (scope.kind) {
    case 'tenant': return 'whole estate';
    case 'region': return scope.region;
    case 'site': return scope.siteId.toUpperCase() + ' only';
    case 'device': return 'one device';
  }
}
