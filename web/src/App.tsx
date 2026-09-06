/**
 * The dispatch board.
 *
 * One screen, three panes: who is out there (roster), where they are (map),
 * and what needs a decision (feed). A dispatcher watches this for a shift, so
 * the layout does not move and nothing animates that does not carry meaning.
 */
import { useEffect, useMemo, useState } from 'react';
import { DispatchMap } from './DispatchMap.tsx';
import { DriverPanel } from './DriverPanel.tsx';
import { inProcessTransport } from './transport/in-process.ts';
import { SignIn } from './SignIn.tsx';
import { useRestoredSession } from './auth/useSession.ts';
import { localAuth } from './auth/local.ts';
import type { Session } from './auth/index.ts';
import type { BoardSnapshot, Driver, Exception } from './transport/index.ts';

/** 11 hours is the US federal daily driving limit. The strip is scaled to it. */
const HOS_MAX_MINUTES = 660;
/** The same thresholds the detection rules use. They must not diverge. */
const HOS_WARNING = 60;
const HOS_CRITICAL = 40;

const DISTRICTS = [
  { id: 'dal', name: 'Dallas' },
  { id: 'aus', name: 'Austin' },
  { id: 'den', name: 'Denver' },
  { id: 'chi', name: 'Chicago' },
  { id: 'phx', name: 'Phoenix' },
];

/**
 * The shell. Sign-in gates everything, so there is no render path that reads
 * fleet data without a verified token behind it.
 */
export function App() {
  const [session, setSession] = useRestoredSession();

  // Install the session before the board mounts, not inside it - the transport
  // throws without one, deliberately.
  useEffect(() => {
    inProcessTransport.setSession(session?.principal ?? null);
  }, [session]);

  if (!session) return <SignIn onSignedIn={setSession} />;

  return (
    <Board
      key={session.principal.sub}
      session={session}
      onSignOut={() => { localAuth.signOut(); setSession(null); }}
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

  useEffect(() => {
    let stale = false;
    setLive([]);
    inProcessTransport.loadBoard(districtId).then((snapshot) => {
      if (!stale) setBoard(snapshot);
    });
    return () => { stale = true; };
  }, [districtId]);

  // The live channel. Exceptions only - positions are not pushed.
  useEffect(() => {
    return inProcessTransport.subscribeExceptions(districtId, (exception) => {
      setLive((prev) => (prev.some((e) => e.exceptionId === exception.exceptionId)
        ? prev
        : [exception, ...prev].slice(0, 40)));
    });
  }, [districtId]);

  const flagged = useMemo(() => {
    const ids = new Set<string>();
    for (const i of board?.incidents ?? []) for (const d of i.driverIds) ids.add(d);
    return ids;
  }, [board]);

  const drivers = board?.drivers ?? [];
  const paged = board?.incidents.flatMap((i) => i.exceptionIds) ?? [];
  const pagedSet = useMemo(() => new Set(paged), [board]);

  const feed = useMemo(() => {
    const all = [...(board?.exceptions ?? [])];
    return all.sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt));
  }, [board]);

  // Which tabs this token permits. Tenant scope sees all of them; a district
  // dispatcher sees exactly one, so the row becomes a label rather than a
  // control - which is the honest rendering of a permission.
  const visibleDistricts = scope.kind === 'district'
    ? DISTRICTS.filter((d) => d.id === scope.districtId)
    : DISTRICTS;
  const canSeeAll = scope.kind === 'tenant' || scope.kind === 'region';

  const criticalCount = board?.incidents.filter((i) => i.severity === 'critical').length ?? 0;
  const heldCount = board?.heldBack.length ?? 0;

  const selectedDriver = drivers.find((d) => d.driverId === selected);
  const selectedExceptions = (board?.exceptions ?? []).filter((e) => e.driverId === selected);

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
              key={d.id}
              className="district"
              aria-pressed={districtId === d.id}
              onClick={() => { setDistrictId(d.id); setSelected(undefined); }}
            >
              {d.id}
              {districtId === d.id && <span className="count">{drivers.length}</span>}
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
        <div className="clock">
          <span className="pulse" aria-hidden="true" />
          <span>14:30:00Z</span>
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
            <span className="mono">{drivers.length}</span>
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
            {drivers.length === 0 && (
              <p className="empty">No drivers on shift in this district.</p>
            )}
          </div>
        </aside>

        <main className="stage">
          <div className="map-wrap">
            <DispatchMap
              drivers={drivers}
              flagged={flagged}
              selectedId={selected}
              onSelect={setSelected}
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
            </div>

            <p className="scale-note">
              {drivers.length} drivers, {live.length > 0 ? live.length : 'no'} live
              {live.length === 1 ? ' exception' : ' exceptions'}. Positions refresh on a
              poll; only exceptions are pushed.
            </p>
          </div>

          <section className="feed">
            <div className="pane-head">
              <span>Exceptions</span>
              <span className="mono">{feed.length}</span>
            </div>
            <div className="feed-list">
              {feed.map((e) => (
                <ExceptionRow
                  key={e.exceptionId}
                  exception={e}
                  paged={pagedSet.has(e.exceptionId)}
                  onSelect={() => setSelected(e.driverId)}
                />
              ))}
              {feed.length === 0 && (
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
            districtId={districtId}
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

      <span style={{ minWidth: 0 }}>
        <span className="driver-id">{driver.driverId.replace('drv-', '')}</span>{' '}
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
function HoursOfServiceStrip({ minutes, level }: {
  minutes: number;
  level: 'warning' | 'critical' | null;
}) {
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

function ExceptionRow({ exception, paged, onSelect }: {
  exception: Exception;
  paged: boolean;
  onSelect(): void;
}) {
  return (
    <button className={`exception ${paged ? '' : 'is-noise'}`} onClick={onSelect}>
      <span className="exception-time">{exception.raisedAt.slice(11, 19)}</span>
      <span className="exception-kind">{exception.kind.replace(/-/g, ' ')}</span>
      <span className="exception-detail">
        <b>{exception.driverId.replace('drv-', '')}</b>
        {' · '}
        {exception.providers.length === 1
          ? `${exception.providers[0]} only`
          : `${exception.providers.join(' + ')} agree`}
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

function hosLevel(minutes: number): 'warning' | 'critical' | null {
  if (minutes <= HOS_CRITICAL) return 'critical';
  if (minutes <= HOS_WARNING) return 'warning';
  return null;
}

/** 128 -> "2h08". Hours and minutes, because that is how a shift is discussed. */
function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${String(m).padStart(2, '0')}`;
}
