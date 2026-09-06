/**
 * The dispatch board.
 *
 * One screen, three panes: who is out there (roster), where they are (map),
 * and what needs a decision (feed). A dispatcher watches this for a shift, so
 * the layout does not move and nothing animates that does not carry meaning.
 *
 * The one thing that DOES move is the fleet. Positions replay from the seeded
 * thirty-minute trace on a coarse tick - the same cadence a real client polls
 * at, because pushing 11,000 readings/sec of pin movement would be useless to
 * a human and ruinous to pay for. Exceptions, by contrast, arrive on the push
 * channel the moment the rules raise them. That asymmetry is the architecture,
 * and the board shows it rather than describing it.
 */
import { useEffect, useMemo, useState } from 'react';
import { DispatchMap, type BasemapMode } from './DispatchMap.tsx';
import { DriverPanel } from './DriverPanel.tsx';
import { inProcessTransport } from './transport/in-process.ts';
import { SignIn } from './SignIn.tsx';
import { useRestoredSession } from './auth/useSession.ts';
import { auth } from './auth/provider.ts';
import { HOS_MAX_MINUTES, formatHours, hosLevel, witness, type HosLevel } from './format.ts';
import { DISTRICTS } from '../../src/data/districts.ts';
import type { Session } from './auth/index.ts';
import type { BoardSnapshot, Driver, Exception, PositionTick } from './transport/index.ts';

/**
 * The shell. Sign-in gates everything, so there is no render path that reads
 * fleet data without a verified token behind it. The transport learns about
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

  // A dispatcher opens on their own district and has no other option. An ops
  // lead opens tenant-wide. The board does not offer what the token forbids -
  // showing tabs that return nothing would read as a bug rather than a rule.
  const [districtId, setDistrictId] = useState<string | undefined>(
    scope.kind === 'district' ? scope.districtId : undefined,
  );
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [live, setLive] = useState<Exception[]>([]);
  const [tick, setTick] = useState<PositionTick | null>(null);
  const [basemap, setBasemap] = useState<BasemapMode | undefined>();
  const [basemapActual, setBasemapActual] = useState<BasemapMode>('canvas');

  // --- Snapshot ------------------------------------------------------------
  useEffect(() => {
    let stale = false;
    setLive([]);
    setTick(null);
    inProcessTransport.loadBoard(districtId).then((snapshot) => {
      if (!stale) setBoard(snapshot);
    });
    return () => { stale = true; };
  }, [districtId]);

  // --- Positions: polled cadence, replayed from the trace ------------------
  useEffect(
    () => inProcessTransport.subscribePositions(districtId, setTick),
    [districtId],
  );

  // --- Exceptions: the push channel. Only these are pushed, never positions.
  useEffect(() => {
    return inProcessTransport.subscribeExceptions(districtId, (exception) => {
      setLive((prev) => (prev.some((e) => e.exceptionId === exception.exceptionId)
        ? prev
        : [exception, ...prev].slice(0, 40)));
    });
  }, [districtId]);

  // The fleet as it is NOW: the snapshot's roster, with each driver moved to
  // wherever the latest tick put them. The snapshot is the source of truth for
  // who exists; the tick is only ever a position.
  const drivers = useMemo<Driver[]>(() => {
    const base = board?.drivers ?? [];
    if (!tick) return base;
    return base.map((d) => {
      const p = tick.positions.get(d.driverId);
      return p ? { ...d, lon: p.lon, lat: p.lat, status: p.status } : d;
    });
  }, [board, tick]);

  const flagged = useMemo(() => {
    const ids = new Set<string>();
    for (const i of board?.incidents ?? []) for (const d of i.driverIds) ids.add(d);
    return ids;
  }, [board]);

  const pagedSet = useMemo(
    () => new Set(board?.incidents.flatMap((i) => i.exceptionIds) ?? []),
    [board],
  );

  // The feed: what the rules raised in the snapshot, plus whatever has arrived
  // live since. Live arrivals are marked, so the push channel is visible as a
  // thing that happens rather than a count in a corner.
  const liveIds = useMemo(() => new Set(live.map((e) => e.exceptionId)), [live]);
  const feed = useMemo(() => {
    const byId = new Map<string, Exception>();
    for (const e of board?.exceptions ?? []) byId.set(e.exceptionId, e);
    for (const e of live) byId.set(e.exceptionId, e);
    return [...byId.values()].sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt));
  }, [board, live]);

  // Which tabs this token permits. Tenant scope sees all of them; a district
  // dispatcher sees exactly one, so the row becomes a label rather than a
  // control - which is the honest rendering of a permission. Driver scope
  // sees none: their assignments are not a district, and five tabs that each
  // return nothing would read as a bug rather than a rule.
  const visibleDistricts = scope.kind === 'district'
    ? DISTRICTS.filter((d) => d.districtId === scope.districtId)
    : scope.kind === 'driver' ? [] : DISTRICTS;
  const canSeeAll = scope.kind === 'tenant' || scope.kind === 'region';

  const criticalCount = board?.incidents.filter((i) => i.severity === 'critical').length ?? 0;
  const heldCount = board?.heldBack.length ?? 0;

  const selectedDriver = drivers.find((d) => d.driverId === selected);
  const selectedExceptions = feed.filter((e) => e.driverId === selected);

  const moving = drivers.filter((d) => d.status === 'driving').length;

  return (
    <div className="shell">
      <header className="statusbar">
        <div className="brand">
          <span className="brand-mark">MERIDIAN</span>
          <span className="brand-rule" />
        </div>

        <nav className="districts" aria-label="District">
          {visibleDistricts.map((d) => (
            <button
              key={d.districtId}
              className="district"
              title={d.name}
              aria-pressed={districtId === d.districtId}
              onClick={() => { setDistrictId(d.districtId); setSelected(undefined); }}
            >
              {d.districtId}
              {districtId === d.districtId && <span className="count">{drivers.length}</span>}
            </button>
          ))}
          {/* Not a sixth district - a different ROLE, and only offered to a
              token that carries it. */}
          {canSeeAll && (
            <button
              className="district is-lead"
              aria-pressed={districtId === undefined}
              onClick={() => { setDistrictId(undefined); setSelected(undefined); }}
              title="Tenant-wide scope, granted by the admin role"
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
        <div className="clock" title="Replaying the seeded trace">
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

      <div className={`body ${selectedDriver ? 'has-panel' : ''}`}>
        <aside className="roster">
          <div className="pane-head">
            <span>Roster</span>
            <span className="mono">
              <span className="roster-moving">{moving}</span> / {drivers.length}
            </span>
          </div>
          <div className="roster-list">
            {drivers.map((d) => (
              <DriverRow
                key={d.driverId}
                driver={d}
                flagged={flagged.has(d.driverId)}
                selected={selected === d.driverId}
                onSelect={() => setSelected(d.driverId)}
              />
            ))}
            {drivers.length === 0 && board && (
              <p className="empty">No drivers on shift in this district.</p>
            )}
            {!board && <p className="empty">Loading the roster…</p>}
          </div>
        </aside>

        <main className="stage">
          <div className="map-wrap">
            <DispatchMap
              drivers={drivers}
              flagged={flagged}
              selectedId={selected}
              onSelect={setSelected}
              basemap={basemap}
              onBasemap={setBasemapActual}
            />

            <div className="legend">
              <div className="legend-row">
                <span className="legend-dot" style={{ background: 'var(--driving)' }} /> driving
              </div>
              <div className="legend-row">
                <span className="legend-dot" style={{ background: 'var(--stopped)' }} /> stopped
              </div>
              <div className="legend-row">
                <span className="legend-dot" style={{ background: 'var(--on-break)' }} /> on break
              </div>
              <div className="legend-row">
                <span className="legend-dot" style={{ background: 'var(--off-duty)' }} /> off duty
              </div>
              <div className="legend-row">
                <span className="legend-line" /> route corridor
              </div>
              <div className="legend-row">
                <span className="legend-halo" /> exception
              </div>

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
              <b>{drivers.length}</b> drivers, <b>{moving}</b> moving.{' '}
              {live.length > 0
                ? <><b>{live.length}</b> live {live.length === 1 ? 'exception' : 'exceptions'} pushed.</>
                : 'Nothing pushed yet.'}
              <br />
              <span className="scale-sub">Positions poll every tick. Only exceptions are pushed.</span>
            </p>
          </div>

          <section className="feed">
            <div className="pane-head">
              <span>Exceptions</span>
              <span className="mono">
                {live.length > 0 && <span className="feed-live">{live.length} live</span>}
                {feed.length}
              </span>
            </div>
            <div className="feed-list">
              {feed.map((e) => (
                <ExceptionRow
                  key={e.exceptionId}
                  exception={e}
                  paged={pagedSet.has(e.exceptionId)}
                  live={liveIds.has(e.exceptionId)}
                  onSelect={() => setSelected(e.driverId)}
                />
              ))}
              {feed.length === 0 && board && (
                <p className="empty">Nothing raised in this district. Quiet is the goal.</p>
              )}
            </div>
          </section>
        </main>

        {selectedDriver && (
          <DriverPanel
            key={selectedDriver.driverId}
            driver={selectedDriver}
            exceptions={selectedExceptions}
            paged={pagedSet}
            onClose={() => setSelected(undefined)}
          />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function DriverRow({ driver, flagged, selected, onSelect }: {
  driver: Driver;
  flagged: boolean;
  selected: boolean;
  onSelect(): void;
}) {
  const level = hosLevel(driver.hosRemainingMinutes);

  return (
    <button className="driver" aria-selected={selected} onClick={onSelect}>
      <span className={`status-bar status-${driver.status}`} aria-hidden="true" />

      <span className="driver-who">
        <span className="driver-id">{driver.driverId.replace('drv-', '')}</span>
        <span className="driver-name">{driver.name}</span>
      </span>

      <span className="hos">
        {flagged && <span className="driver-flag is-critical">EXC</span>}
        <HoursOfServiceStrip minutes={driver.hosRemainingMinutes} level={level} />
        <span className={`hos-clock ${level ? `is-${level}` : ''}`}>
          {formatHours(driver.hosRemainingMinutes)}
        </span>
      </span>
    </button>
  );
}

/**
 * The hours-of-service strip.
 *
 * A miniature of the ELD duty-status log every driver and dispatcher reads
 * daily: an eleven-hour ruled grid, filled to the drive time remaining. The
 * fill turns amber then red at exactly the thresholds the detection rules use,
 * so the strip and the alert are reading the same number and cannot disagree.
 */
function HoursOfServiceStrip({ minutes, level }: { minutes: number; level: HosLevel }) {
  const pct = Math.max(0, Math.min(100, (minutes / HOS_MAX_MINUTES) * 100));
  return (
    <span
      className="hos-strip"
      role="meter"
      aria-valuenow={minutes}
      aria-valuemin={0}
      aria-valuemax={HOS_MAX_MINUTES}
      aria-label={`${formatHours(minutes)} of drive time remaining`}
    >
      <span className={`hos-fill ${level ? `is-${level}` : ''}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function ExceptionRow({ exception, paged, live, onSelect }: {
  exception: Exception;
  paged: boolean;
  live: boolean;
  onSelect(): void;
}) {
  return (
    <button
      className={`exception ${paged ? '' : 'is-noise'} ${live ? 'is-live' : ''}`}
      onClick={onSelect}
    >
      <span className="exception-time">{exception.raisedAt.slice(11, 19)}</span>
      <span className="exception-kind">{exception.kind.replace(/-/g, ' ')}</span>
      <span className="exception-detail">
        <b>{exception.driverId.replace('drv-', '')}</b>
        {' · '}
        {witness(exception, paged)}
      </span>
      <span className={`verdict ${paged ? 'is-paged' : 'is-held'}`}>
        {paged ? 'PAGED' : 'HELD'}
      </span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */

/** The caller's reach, in the words a dispatcher would use. */
function describeScope(scope: Session['principal']['scope']): string {
  switch (scope.kind) {
    case 'tenant': return 'whole carrier';
    case 'region': return scope.region;
    case 'district': return scope.districtId.toUpperCase() + ' only';
    case 'driver': return 'own assignments';
  }
}
