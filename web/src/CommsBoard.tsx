/**
 * ---------------------------------------------------------------------------
 * The comms view: Teams, Genesys and Webex
 * ---------------------------------------------------------------------------
 * Same board, same grammar, different subjects. There is no map, because the
 * subjects are not places on one: a trunk is an SBC's FQDN, a queue lives in a
 * contact-centre cloud, and a facility is a code in an address. Drawing them
 * on a map would invent coordinates the data does not have.
 *
 * Three panes, as on the network side:
 *
 *   what needs a decision   incidents, and held-back alarms dimmed beside them
 *   who is affected         the workforce split - counts, never names
 *   why                     the assistant, showing its working
 *
 * A FACILITY WITH AN OPEN INCIDENT IS AMBER in the workforce table. That is
 * the one join an ops lead actually makes by eye - "Houston's calls are bad;
 * how many people is that?" - and the board makes it without them asking.
 */
import { useState } from 'react';
import { inProcessTransport } from './transport/in-process.ts';
import { TraceStep } from './DevicePanel.tsx';
import type { AgentResult, CommsAlarm, CommsIncident, WorkforceSummary } from './transport/index.ts';
import type { CommsSnapshot } from './transport/index.ts';

const PLATFORMS = ['teams', 'genesys', 'webex'] as const;

const SUBJECT_LABEL: Record<CommsIncident['subject']['kind'], string> = {
  trunk: 'trunk',
  facility: 'facility',
  queue: 'queue',
};

const DEFAULT_QUESTION = 'Why is call quality bad in Houston, and did anything page?';

export function CommsBoard({ snapshot }: { snapshot: CommsSnapshot }) {
  const affected = new Set(
    snapshot.incidents.filter((i) => i.subject.kind === 'facility').map((i) => i.subject.id),
  );

  return (
    <div className="comms-body">
      <aside className="roster">
        <div className="pane-head">
          <span>Comms incidents</span>
          <span className="mono">{snapshot.incidents.length} · {snapshot.heldBack.length} held</span>
        </div>
        <div className="roster-list">
          {snapshot.incidents.map((i) => <IncidentRow key={i.incidentId} incident={i} />)}
          {snapshot.heldBack.map((a) => <HeldRow key={a.alarmId} alarm={a} />)}
          {snapshot.incidents.length === 0 && snapshot.heldBack.length === 0 && (
            <p className="empty">Nothing raised on any trunk, facility or queue. Quiet is the goal.</p>
          )}
        </div>
      </aside>

      <main className="comms-main">
        <div className="pane-head">
          <span>Voice users</span>
          <span className="mono">as of {snapshot.workforce.asOf.slice(11, 19)}Z</span>
        </div>
        <Workforce workforce={snapshot.workforce} affected={affected} />
      </main>

      <Assistant />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function IncidentRow({ incident }: { incident: CommsIncident }) {
  return (
    <div className="comms-incident">
      <div className="exception">
        <span className="exception-time">{incident.openedAt.slice(11, 19)}</span>
        <span className="exception-kind">{SUBJECT_LABEL[incident.subject.kind]}</span>
        <span className="exception-detail">
          <b>{incident.title}</b>
          {' · '}
          {incident.sources.join(' + ')}
        </span>
        <span className="verdict is-paged">PAGED</span>
      </div>
      <ul className="comms-evidence">
        {(incident.localisation ?? []).map((l) => <li key={l} className="is-where">{l}</li>)}
        {incident.evidence.map((e) => <li key={e}>{e}</li>)}
      </ul>
    </div>
  );
}

/**
 * Held back, dimmed, with the reason - the same treatment as `.is-noise` on
 * the network feed. "Why did nothing page?" is answered on the board itself.
 */
function HeldRow({ alarm }: { alarm: CommsAlarm }) {
  return (
    <div className="comms-incident is-noise">
      <div className="exception">
        <span className="exception-time">{alarm.raisedAt.slice(11, 19)}</span>
        <span className="exception-kind">{SUBJECT_LABEL[alarm.subject.kind]}</span>
        <span className="exception-detail">
          <b>{alarm.subject.name}</b>
          {' · '}
          {alarm.heldBack}
        </span>
        <span className="verdict is-held">HELD</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Workforce({ workforce, affected }: { workforce: WorkforceSummary; affected: Set<string> }) {
  const agencies = [...new Set(PLATFORMS.flatMap((p) => Object.keys(workforce.byPlatform[p]?.byAgency ?? {})))].sort();
  const contractorDomains = [...new Set(PLATFORMS.flatMap((p) =>
    Object.keys(workforce.byPlatform[p]?.contractorsByDomain ?? {})))].sort();
  const unknownDomains = [...new Set(PLATFORMS.flatMap((p) =>
    Object.keys(workforce.byPlatform[p]?.unknownByDomain ?? {})))].sort();

  const cell = (p: (typeof PLATFORMS)[number], pick: (s: NonNullable<WorkforceSummary['byPlatform']['teams']>) => number | undefined) => {
    const split = workforce.byPlatform[p];
    return <td key={p} className="num">{split ? (pick(split) ?? 0) : '–'}</td>;
  };

  const unplaced = Object.entries(workforce.unplacedByReason).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));

  return (
    <div className="comms-tables">
      {(workforce.directory.status === 'first-sync-in-progress' || workforce.directory.status === 'never-synced') && (
        <p className="comms-warning">
          The Entra directory is still on its first sync. Facility counts are incomplete until it finishes.
        </p>
      )}
      {workforce.directory.status === 'resyncing' && (
        <p className="comms-warning">
          The Entra directory is resyncing. Facility counts use the previous copy meanwhile.
        </p>
      )}
      {workforce.truncated && (
        <p className="comms-warning">
          A source returned a truncated listing. These counts are LOW, not complete.
        </p>
      )}

      <table className="comms-table">
        <caption>By agency — from the email domain</caption>
        <thead>
          <tr><th scope="col" />{PLATFORMS.map((p) => <th key={p} scope="col">{p}</th>)}</tr>
        </thead>
        <tbody>
          {agencies.map((a) => (
            <tr key={a}>
              <th scope="row">{a}</th>
              {PLATFORMS.map((p) => cell(p, (s) => s.byAgency[a]))}
            </tr>
          ))}
          {contractorDomains.map((d) => (
            <tr key={d} className="is-minor">
              <th scope="row">contractor <span className="mono">{d}</span></th>
              {PLATFORMS.map((p) => cell(p, (s) => s.contractorsByDomain[d]))}
            </tr>
          ))}
          {/* An unknown domain is a gap in the tenant's configuration, so it is
              the one row in this table that is allowed to ask for attention. */}
          {unknownDomains.map((d) => (
            <tr key={d} className="is-attention">
              <th scope="row">unknown <span className="mono">{d}</span></th>
              {PLATFORMS.map((p) => cell(p, (s) => s.unknownByDomain[d]))}
            </tr>
          ))}
        </tbody>
      </table>

      <table className="comms-table">
        <caption>By facility — Entra LC= code, then Webex location</caption>
        <thead>
          <tr><th scope="col" />{PLATFORMS.map((p) => <th key={p} scope="col">{p}</th>)}</tr>
        </thead>
        <tbody>
          {workforce.byFacility.map((f) => (
            <tr key={f.code} className={affected.has(f.code) ? 'is-attention' : ''}>
              <th scope="row">
                <span className="mono">LC={f.code}</span>
                {affected.has(f.code) && <span className="comms-flag">incident</span>}
              </th>
              {PLATFORMS.map((p) => <td key={p} className="num">{f.counts[p] ?? 0}</td>)}
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="comms-foot">
        <div>
          <dt>Not counted</dt>
          <dd>
            {workforce.byPlatform.teams?.excluded.resourceAccounts ?? 0} Teams resource accounts (not staff) ·{' '}
            {workforce.byPlatform.genesys?.excluded.inactive ?? 0} inactive Genesys users
          </dd>
        </div>
        <div>
          <dt>Not placed</dt>
          <dd>
            {unplaced.length === 0 ? 'everyone placed' : unplaced.map(([reason, n]) => n + ' ' + reason.replace(/-/g, ' ')).join(' · ')}
          </dd>
        </div>
        {(workforce.facilityConflicts > 0 || workforce.unmappedWebexLocations.length > 0) && (
          <div className="is-attention">
            <dt>To fix</dt>
            <dd>
              {workforce.facilityConflicts} Entra/Webex facility conflicts
              {workforce.unmappedWebexLocations.length > 0 &&
                ' · unmapped Webex locations: ' + workforce.unmappedWebexLocations.join(', ')}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Assistant() {
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setAsking(true);
    setError(null);
    try {
      setResult(await inProcessTransport.askAgent(question));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The assistant did not respond.');
    } finally {
      setAsking(false);
    }
  }

  return (
    <aside className="panel">
      <div className="pane-head"><span>Assistant</span></div>
      <div className="panel-body">
        <form className="comms-ask" onSubmit={(e) => { e.preventDefault(); if (!asking) void ask(); }}>
          <label className="field-label" htmlFor="comms-question">Question</label>
          <textarea
            id="comms-question"
            className="field-input comms-question"
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button className="ask" type="submit" disabled={asking || question.trim() === ''}>
            {result ? 'Ask again' : 'Ask'}
          </button>
        </form>

        {asking && (
          <p className="panel-working">
            <span className="pulse" aria-hidden="true" /> Working — reading comms incidents and the workforce.
          </p>
        )}

        {error && <p className="panel-error">{error} Try again, or read the incidents on the left directly.</p>}

        {result && !asking && (
          <>
            <ol className="trace">
              {result.trace.map((t) => <TraceStep key={t.step} step={t} />)}
            </ol>
            <p className="answer">{result.answer}</p>
            <p className="usage mono">
              {result.usage.modelCalls} model calls · stopped: {result.stoppedBecause.replace(/_/g, ' ')}
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
