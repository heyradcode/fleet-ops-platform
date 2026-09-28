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
import { transport } from './transport/select.ts';
import { agentSource } from './agentSource.ts';
import { TraceStep } from './DevicePanel.tsx';
import type {
  AgentResult, AgentTrace, Brief, CommsAlarm, CommsAnomaly, CommsIncident, IntegrationHealth, PhoneInventory, WorkforceSummary,
} from './transport/index.ts';
import type { CandidateCauses, CommsSnapshot } from './transport/index.ts';

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
          {snapshot.incidents.map((i) => <IncidentRow key={i.incidentId} incident={i} causes={snapshot.causes[i.incidentId]} />)}
          {snapshot.heldBack.map((a) => <HeldRow key={a.alarmId} alarm={a} />)}
          {snapshot.anomalies
            .filter((a) => !snapshot.incidents.some((i) => i.subject.kind === a.subject.kind && i.subject.id === a.subject.id))
            .map((a) => <AnomalyRow key={a.subject.id + a.metric + a.source} anomaly={a} />)}
          {snapshot.resolved.map((i) => <ResolvedRow key={i.incidentId} incident={i} />)}
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
        <BriefPanel brief={snapshot.brief} />
        {snapshot.health && <Integrations health={snapshot.health} />}
        <Workforce workforce={snapshot.workforce} affected={affected} />
        {snapshot.phones && <Phones phones={snapshot.phones} affected={affected} />}
      </main>

      <Assistant />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function IncidentRow({ incident, causes }: { incident: CommsIncident; causes?: CandidateCauses }) {
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
        <span className="verdict is-paged">{incident.reopenCount ? 'REOPENED' : 'PAGED'}</span>
      </div>
      <p className="comms-lifecycle">
        open since {incident.openedAt.slice(11, 16)}Z
        {incident.peakSeverity !== incident.severity ? ' · peaked ' + incident.peakSeverity : ''}
        {incident.reopenCount ? ' · flapped ' + incident.reopenCount + '×' : ''}
        {incident.lifecycleNote ? ' · ' + incident.lifecycleNote : ''}
      </p>
      <ul className="comms-evidence">
        {(incident.localisation ?? []).map((l) => <li key={l} className="is-where">{l}</li>)}
        {incident.context?.status === 'ok' && incident.context.changes.map((c) => (
          <li key={c.id} className="is-change">
            change {c.id} “{c.summary}” — {c.endedMinutesBefore === null ? 'in progress'
              : c.endedMinutesBefore < 0 ? 'ended during the window'
                : 'ended ' + c.endedMinutesBefore + ' min before'} · candidate, not cause
          </li>
        ))}
        {incident.context?.status === 'ok' && incident.context.tickets.map((t) => (
          <li key={t.id} className="is-ticket">already in Helix: {t.id} “{t.summary}” · {t.group ?? 'unassigned'}</li>
        ))}
        {incident.context && incident.context.status !== 'ok' && (
          <li className="is-context-note">{incident.context.note}</li>
        )}
        {causes && <Causes causes={causes} />}
        {incident.evidence.map((e) => <li key={e}>{e}</li>)}
      </ul>
    </div>
  );
}

/**
 * What the knowledge graph puts beside an incident: the network in the same
 * building, around that time. Cool, never amber - a candidate is a place to
 * look, not a finding - and "held back" says out loud that the network rules
 * did not think it worth a page on its own. The other three answers are said
 * as themselves: "looked, nothing" is not "could not look".
 */
function Causes({ causes }: { causes: CandidateCauses }) {
  if (causes.status === 'none') return <li className="is-cause-note">knowledge graph: nothing raised on {causes.searched}</li>;
  if (causes.status !== 'found') return <li className="is-cause-note">knowledge graph: {causes.reason}</li>;
  return (
    <>
      {causes.causes.map((c) => (
        <li key={c.id} className="is-cause" title={'path: ' + c.path}>
          {c.device} ({c.role}): {c.what.toLowerCase()}, {c.severity}
          {c.paged ? ', paged' : ', held back (one witness)'} · {minutesLabel(c.minutesBefore)} · candidate cause, via the building
        </li>
      ))}
    </>
  );
}

function minutesLabel(m: number): string {
  if (m === 0) return 'same minute';
  return m > 0 ? m + ' min before' : -m + ' min after';
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

/**
 * Unusual for this subject at this hour of the week, with no incident open -
 * the proactive row. Labelled UNUSUAL, not PAGED: nothing fired, and the row
 * says what "normal" is so the reader can judge the distance themselves.
 */
function AnomalyRow({ anomaly }: { anomaly: CommsAnomaly }) {
  return (
    <div className="comms-incident is-unusual">
      <div className="exception">
        <span className="exception-time">z {anomaly.z}</span>
        <span className="exception-kind">{SUBJECT_LABEL[anomaly.subject.kind]}</span>
        <span className="exception-detail">{anomaly.explanation}</span>
        <span className="verdict is-held">UNUSUAL</span>
      </div>
    </div>
  );
}

/** Resolved, dimmed further than held-back: history, not attention. */
function ResolvedRow({ incident }: { incident: CommsIncident }) {
  return (
    <div className="comms-incident is-resolved">
      <div className="exception">
        <span className="exception-time">{(incident.resolvedAt ?? '').slice(11, 19)}</span>
        <span className="exception-kind">{SUBJECT_LABEL[incident.subject.kind]}</span>
        <span className="exception-detail">
          <b>{incident.title}</b>
          {' · open '}{incident.openedAt.slice(11, 16)}–{(incident.resolvedAt ?? '').slice(11, 16)}Z
        </span>
        <span className="verdict is-held">RESOLVED</span>
      </div>
    </div>
  );
}

/**
 * The executive brief, collapsed to its status line until opened. The status
 * colour is the board's own: red and amber only when they mean it.
 */
function BriefPanel({ brief }: { brief: Brief }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`comms-brief is-${brief.status}`} aria-label="Daily brief">
      <button className="comms-brief-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="comms-brief-status">{brief.status}</span>
        <span className="comms-brief-headline">{brief.headline}</span>
        <span className="comms-brief-toggle">{open ? 'hide' : 'daily brief'}</span>
      </button>
      {open && (
        <div className="comms-brief-body">
          {!brief.confidence.complete && <p className="comms-warning">Built on incomplete data - see the last section.</p>}
          <h4>Open now</h4>
          {brief.open.length === 0 ? <p>Nothing open.</p> : (
            <ul>
              {brief.open.map((i) => (
                <li key={i.id}>
                  <b>{i.title}</b> <span className="dim">- {i.when}</span>
                  <div>Impact: {i.impact}</div>
                  {i.where && <div>Where: {i.where}</div>}
                  {i.status && <div>Status: {i.status}</div>}
                  {i.candidate && <div>{i.candidate} - a candidate, not a confirmed cause</div>}
                  {i.ticket && <div>{i.ticket}</div>}
                  {i.normally && <div className="dim">{i.normally}</div>}
                </li>
              ))}
            </ul>
          )}
          <h4>Resolved in the last 24 hours</h4>
          {brief.resolved.length === 0 ? <p>Nothing resolved.</p>
            : <ul>{brief.resolved.map((r) => <li key={r.id}>{r.title} <span className="dim">- {r.when}</span></li>)}</ul>}
          {brief.unusual.length > 0 && <><h4>Unusual, not yet at alarm level</h4><ul>{brief.unusual.map((u) => <li key={u}>{u}</li>)}</ul></>}
          {brief.watch.length > 0 && <><h4>Watching</h4><ul>{brief.watch.map((w) => <li key={w}>{w}</li>)}</ul></>}
          <h4>How much to trust this</h4>
          <ul>
            {brief.confidence.complete && <li>Every feed answered on the latest poll.</li>}
            {brief.confidence.notes.map((n) => <li key={n}>{n}</li>)}
            {brief.confidence.fixes.map((f) => <li key={f} className="dim">{f}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

const SOURCE_LABEL: Record<string, string> = {
  'entra-directory': 'Entra directory', teams: 'Teams', genesys: 'Genesys', webex: 'Webex',
  bandwidth: 'Bandwidth', helix: 'Helix',
};

/**
 * Is every feed answering? Down is red and stale says so in words; degraded
 * is amber with the gap named; caveats are dimmed text and never a colour -
 * a permanently amber tile would teach people to ignore amber.
 */
function Integrations({ health }: { health: IntegrationHealth }) {
  return (
    <section className="comms-health" aria-label="Integration health">
      <h3 className="comms-health-h">Integrations</h3>
      <ul className="comms-sources">
        {health.sources.map((s) => (
          <li key={s.source} className={`comms-source is-${s.status}`}>
            <span className="comms-source-dot" aria-hidden="true" />
            <span className="comms-source-name">{SOURCE_LABEL[s.source] ?? s.source}</span>
            <span className="comms-source-status">
              {s.status.replace('-', ' ')}{s.stale ? ' · stale' : ''}
              {s.status === 'down' && (
                <span className="comms-source-since">
                  {' · '}{s.lastSuccessAt ? 'last good ' + s.lastSuccessAt.slice(11, 16) + 'Z' : 'no good data yet'}
                </span>
              )}
            </span>
            {s.lastError && s.status === 'down' && <span className="comms-source-error">{s.lastError}</span>}
            {s.gaps.map((g) => <span key={g} className="comms-source-gap">{g}</span>)}
            {s.caveats.map((c) => <span key={c} className="comms-source-caveat">{c}</span>)}
          </li>
        ))}
      </ul>
      {health.dataQuality.length > 0 && (
        <ul className="comms-quality">
          {health.dataQuality.map((q) => (
            <li key={q.kind + q.detail}>
              <span className="comms-quality-what">{q.detail}</span>
              <span className="comms-quality-fix">{q.action}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
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

/**
 * Cisco desk phones from Kurmi. DEVICES, so a table of their own: adding a
 * phone count to a column of people would make every total meaningless.
 */
function Phones({ phones, affected }: { phones: PhoneInventory; affected: Set<string> }) {
  const unknown = Object.entries(phones.unknownAgencyCodes).sort();
  return (
    <div className="comms-tables comms-phones">
      {phones.truncated && (
        <p className="comms-warning">Kurmi returned a truncated slice even after partitioning. Phone counts are LOW.</p>
      )}
      <table className="comms-table">
        <caption>Cisco desk phones (Kurmi) — devices, not people · {phones.total} enabled, {phones.disabled} disabled not counted</caption>
        <tbody>
          {Object.entries(phones.byAgency).sort().map(([a, n]) => (
            <tr key={a}><th scope="row">{a}</th><td className="num">{n}</td></tr>
          ))}
          {unknown.map(([code, n]) => (
            <tr key={code} className="is-attention"><th scope="row">unknown code <span className="mono">{code}</span></th><td className="num">{n}</td></tr>
          ))}
          {phones.blankAgency > 0 && (
            <tr className="is-attention"><th scope="row">no agency set</th><td className="num">{phones.blankAgency}</td></tr>
          )}
        </tbody>
      </table>
      <table className="comms-table">
        <caption>Cisco desk phones by facility — Kurmi department leaf</caption>
        <tbody>
          {phones.byFacility.map((f) => (
            <tr key={f.code} className={affected.has(f.code) ? 'is-attention' : ''}>
              <th scope="row"><span className="mono">LC={f.code}</span>
                {affected.has(f.code) && <span className="comms-flag">incident</span>}</th>
              <td className="num">{f.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Assistant() {
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<AgentTrace[]>([]);

  async function ask() {
    setAsking(true);
    setError(null);
    setLive([]);
    try {
      setResult(await transport.askAgent(question, (step) => setLive((prev) => [...prev, step])));
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

        {asking && live.length > 0 && (
          <ol className="trace">{live.map((t) => <TraceStep key={t.step} step={t} />)}</ol>
        )}
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
              {agentSource(result)}
            </p>
            {transport.newConversation && (
              <button className="linkish" onClick={() => { transport.newConversation!(); setResult(null); }}>
                New conversation
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
