/**
 * ---------------------------------------------------------------------------
 * The audit view: what the assistant's tools were asked, by whom, and how
 * ---------------------------------------------------------------------------
 * Offered to admins only - it names who asked what, which is not an
 * operator's business about their colleagues - and read-only, like the rest
 * of the board.
 *
 * WHAT IS SHOWN IS WHAT WAS KEPT: a hash of the arguments, never the
 * arguments; no answers. The view cannot show a question an operator typed,
 * because nothing stored it. That is the point, and the column header says so.
 *
 * THE SOURCE IS SAID OUT LOUD. Over the board API this is the MCP server's
 * trail in DynamoDB - the control. In the tab it is the tab assistant's own
 * record, kept in the browser, which is a demonstration and never a control:
 * a record kept on the caller's machine is one the caller can edit. A view
 * that did not say which would let the second pass for the first.
 *
 * AMBER IS FOR `refused` ONLY: a caller asking for something their role or
 * their tool list did not allow is the row an access review exists to find.
 * A tool answering "unknown deviceId" is routine - the model corrects itself
 * - and stays in the calm text colour.
 */
import { useEffect, useState } from 'react';
import { transport, usingBoardApi, usingAgentCore } from './transport/select.ts';
import { BoardApiError } from './transport/api.ts';
import type { AuditEntry, AuditSnapshot } from './transport/index.ts';

export function AuditBoard({ me, onExpired }: { me: string; onExpired(reason: string): void }) {
  const [snapshot, setSnapshot] = useState<AuditSnapshot | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);

  // Loaded on open and on Refresh, never polled: an admin reviewing a trail
  // wants it to hold still while they read it.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    transport.loadAudit()
      .then((s) => { if (!stale) { setSnapshot(s); setError(null); setLoading(false); } })
      .catch((err: unknown) => {
        if (stale) return;
        setLoading(false);
        if (err instanceof BoardApiError && err.status === 401) { onExpired(err.message); return; }
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => { stale = true; };
  }, [generation]);

  const refresh = (
    <button className="audit-refresh" onClick={() => setGeneration((g) => g + 1)} disabled={loading}>
      {loading ? 'loading' : 'refresh'}
    </button>
  );

  if (error) {
    return <div className="audit-body"><p className="panel-error audit-message">Audit trail: {error} {refresh}</p></div>;
  }
  if (snapshot === undefined) return <div className="audit-body"><p className="empty">Loading the audit trail…</p></div>;
  if (snapshot === null) {
    // The board only offers this view to an admin, so the API saying "not
    // yours" means the two disagree about the role - say that, not "empty".
    return <div className="audit-body"><p className="empty">The audit trail is for admins, and this session is not one.</p></div>;
  }

  const { entries, summary } = snapshot;

  return (
    <div className="audit-body">
      <aside className="roster">
        <div className="pane-head">
          <span>By tool</span>
          <span className="mono">{summary.calls} calls</span>
        </div>
        <div className="audit-side">
          <Source />
          {summary.byTool.length > 0 && (
            <table className="comms-table audit-tools">
              <thead>
                <tr><th>tool</th><th>calls</th><th>err</th><th>refused</th><th>p50 ms</th></tr>
              </thead>
              <tbody>
                {summary.byTool.map((t) => (
                  <tr key={t.tool} className={t.refused > 0 ? 'is-attention' : ''}>
                    <th className="mono">{t.tool}</th>
                    <td className="num">{t.calls}</td>
                    <td className="num">{t.error || '·'}</td>
                    <td className="num">{t.refused || '·'}</td>
                    <td className="num">{t.medianMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <dl className="comms-foot">
            <div className={summary.refused > 0 ? 'is-attention' : ''}>
              <dt>outcomes</dt>
              <dd className="mono">{summary.ok} ok · {summary.error} error · {summary.refused} refused</dd>
            </div>
            <div>
              <dt>window</dt>
              <dd className="mono">
                {summary.from && summary.to ? stamp(summary.from) + ' → ' + stamp(summary.to) : 'nothing recorded'}
                {entries.length >= snapshot.limit && ' (the newest ' + snapshot.limit + ')'}
              </dd>
            </div>
            <div>
              <dt>kept</dt>
              <dd>{snapshot.retentionDays} days, then deleted by the table itself</dd>
            </div>
          </dl>
        </div>
      </aside>

      <main className="comms-main">
        <div className="pane-head">
          <span>Tool calls, newest first</span>
          {refresh}
        </div>
        <div className="comms-tables">
          {entries.length === 0 ? <Empty /> : (
            <table className="comms-table audit-table">
              <thead>
                <tr>
                  <th title="Real time, UTC - when the person asked, not the replay's clock">when (UTC)</th>
                  <th>who</th>
                  <th>tool</th>
                  <th>outcome</th>
                  <th>ms</th>
                  <th title="mcp: recorded by the MCP server. tab: recorded in a browser tab - a demonstration.">via</th>
                  <th title="SHA-256 of the arguments. The arguments themselves are never stored - they can carry names.">args (hash)</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => <Row key={e.at + e.argsHash + String(i)} entry={e} me={me} />)}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}

function Row({ entry: e, me }: { entry: AuditEntry; me: string }) {
  return (
    <tr className={e.outcome === 'refused' ? 'is-attention' : e.outcome === 'ok' ? '' : 'is-error'}>
      <th className="mono">{stamp(e.at)}</th>
      <td className="mono" title={e.sub}>{e.sub === me ? 'you' : shortSub(e.sub)}</td>
      <td className="mono">{e.tool}</td>
      <td className="mono">{e.outcome}</td>
      <td className="num">{e.ms}</td>
      <td className="mono">{e.via}</td>
      <td className="mono audit-hash" title={e.argsHash}>{e.argsHash.slice(0, 10)}</td>
    </tr>
  );
}

/** Where this trail comes from - the difference between a control and a demonstration. */
function Source() {
  if (usingBoardApi) {
    return (
      <p className="audit-source">
        Recorded by the <strong>MCP server</strong> on every tool call the AgentCore assistant makes,
        read from the operational table.
      </p>
    );
  }
  return (
    <p className="comms-warning audit-source">
      Recorded <strong>in this browser tab</strong> by the tab's assistant: a demonstration of the trail,
      not a control - a record kept on your own machine is one you could edit. On AWS the MCP server keeps it.
      {usingAgentCore && ' The assistant here runs on AgentCore, so its calls are recorded in DynamoDB - which this board reads only through the board API.'}
    </p>
  );
}

function Empty() {
  return usingBoardApi ? (
    <p className="empty">
      No tool calls recorded. They appear here when the assistant runs on AgentCore with its tools
      over MCP (use_mcp_tools) - ask it something on the network view.
    </p>
  ) : (
    <p className="empty">
      No tool calls yet. Ask the assistant something on the network view: every tool it runs is
      recorded here, with a hash of its arguments and never the arguments.
    </p>
  );
}

/** 2026-09-28T10:00:03.123Z -> 09-28 10:00:03 */
function stamp(iso: string): string {
  return iso.slice(5, 10) + ' ' + iso.slice(11, 19);
}

/** A Cognito sub is a UUID; the first block is enough to tell people apart, and the title has the rest. */
function shortSub(sub: string): string {
  return sub.length > 10 ? sub.slice(0, 8) + '…' : sub;
}
