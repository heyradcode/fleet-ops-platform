/**
 * ---------------------------------------------------------------------------
 * Driver detail, and the assistant
 * ---------------------------------------------------------------------------
 * The panel shows WHY, and it shows its working.
 *
 * Most AI features in products show only the final answer. This one shows the
 * tool calls as they happen - which query ran, which runbook was retrieved,
 * what was refused - because a dispatcher deciding whether to move a load
 * needs to know what the recommendation rests on. An answer with no visible
 * provenance is a thing to be sceptical of, and a dispatcher is right to be.
 *
 * It also makes the authorisation rule visible rather than asserted: a refused
 * tool appears in the trace, in red, with the reason. The agent acts with the
 * caller's permissions, and you can watch that happen.
 */
import { useEffect, useRef, useState } from 'react';
import { inProcessTransport } from './transport/in-process.ts';
import type { AgentResult, AgentTrace, Driver, Exception } from './transport/index.ts';

type Props = {
  driver: Driver;
  exceptions: Exception[];
  districtId?: string;
  onClose(): void;
};

export function DriverPanel({ driver, exceptions, districtId, onClose }: Props) {
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const traceEnd = useRef<HTMLDivElement>(null);

  // A new driver is a new question. Carrying the previous answer over would be
  // worse than showing nothing: it looks like an answer about this driver.
  useEffect(() => { setResult(null); setError(null); }, [driver.driverId]);

  useEffect(() => {
    traceEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [result]);

  const question = questionFor(driver, exceptions);

  async function ask() {
    setAsking(true);
    setError(null);
    try {
      setResult(await inProcessTransport.askAgent(question, districtId));
    } catch (e) {
      // Errors state what happened and what to do, in the interface's voice.
      setError(e instanceof Error ? e.message : 'The assistant did not respond.');
    } finally {
      setAsking(false);
    }
  }

  return (
    <aside className="panel">
      <div className="pane-head">
        <span>Driver</span>
        <button className="panel-close" onClick={onClose} aria-label="Close driver detail">
          ✕
        </button>
      </div>

      <div className="panel-body">
        <header className="panel-id">
          <span className="panel-name">{driver.name}</span>
          <span className="mono panel-driverid">{driver.driverId}</span>
        </header>

        <dl className="facts">
          <Fact label="Vehicle" value={driver.vehicleId} mono />
          <Fact label="District" value={driver.districtId} />
          <Fact label="Status" value={driver.status.replace('-', ' ')} />
          <Fact
            label="Drive time"
            value={formatHours(driver.hosRemainingMinutes)}
            mono
            tone={driver.hosRemainingMinutes <= 40
              ? 'critical'
              : driver.hosRemainingMinutes <= 60 ? 'warning' : undefined}
          />
          <Fact label="Position" value={`${driver.lat.toFixed(4)}, ${driver.lon.toFixed(4)}`} mono />
        </dl>

        {exceptions.length > 0 && (
          <section className="panel-section">
            <h3 className="panel-h">Raised</h3>
            {exceptions.map((e) => (
              <div key={e.exceptionId} className="panel-exception">
                <span className="exception-kind">{e.kind.replace(/-/g, ' ')}</span>
                <span className="panel-witness">
                  {e.providers.length === 1
                    ? `${e.providers[0]} only — not corroborated`
                    : `${e.providers.join(' + ')} agree`}
                </span>
              </div>
            ))}
          </section>
        )}

        <section className="panel-section">
          <h3 className="panel-h">Assistant</h3>

          {!result && !asking && (
            <>
              <p className="panel-question">{question}</p>
              <button className="ask" onClick={ask}>Ask</button>
            </>
          )}

          {asking && (
            <p className="panel-working">
              <span className="pulse" aria-hidden="true" /> Working — retrieving runbooks,
              querying telemetry.
            </p>
          )}

          {error && (
            <p className="panel-error">
              {error} Try again, or check the driver telemetry directly.
            </p>
          )}

          {result && (
            <>
              {/* The trace, first. What it did before what it concluded. */}
              <ol className="trace">
                {result.trace.map((t) => (
                  <TraceStep key={t.step} step={t} />
                ))}
              </ol>
              <div ref={traceEnd} />

              <p className="answer">{result.answer}</p>

              <p className="usage mono">
                {result.usage.modelCalls} model calls ·{' '}
                {result.usage.inputTokens.toLocaleString()} in /{' '}
                {result.usage.outputTokens.toLocaleString()} out · stopped:{' '}
                {result.stoppedBecause.replace(/_/g, ' ')}
              </p>

              <button className="ask" onClick={ask}>Ask again</button>
            </>
          )}
        </section>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */

function TraceStep({ step }: { step: AgentTrace }) {
  // A refused tool is the interesting case, so it is styled as one rather than
  // hidden. This is the authorisation rule made watchable.
  const refused = step.detail.endsWith('-> error') || step.kind === 'guardrail';
  const [name, ...rest] = step.detail.split('(');

  return (
    <li className={`trace-step is-${step.kind} ${refused ? 'is-refused' : ''}`}>
      <span className="trace-n mono">{String(step.step).padStart(2, '0')}</span>
      <span className={`trace-kind is-${step.kind}`}>{step.kind}</span>
      <span className="trace-detail">
        <b>{name}</b>
        {rest.length > 0 && <span className="trace-args">({rest.join('(')}</span>}
      </span>
      <span className="trace-ms mono">{step.ms}ms</span>
    </li>
  );
}

function Fact({ label, value, mono, tone }: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'warning' | 'critical';
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={`${mono ? 'mono' : ''} ${tone ? `is-${tone}` : ''}`}>{value}</dd>
    </>
  );
}

/**
 * Ask about what actually fired.
 *
 * A fixed "why is this driver behind schedule" is worse in two ways. It is
 * worse product design - a dispatcher who clicked a flagged driver wants to
 * ask about the thing that flagged them, not a generic question - and it is
 * worse retrieval, because the runbook corpus is organised by exception kind
 * and a generic question matches all of them weakly rather than one strongly.
 *
 * Phrased the way a dispatcher would say it out loud, not the way the schema
 * spells it.
 */
function questionFor(driver: Driver, exceptions: Exception[]): string {
  const kind = exceptions[0]?.kind;
  const id = driver.driverId;

  switch (kind) {
    case 'route-deviation':
      return `${id} is off their planned route. Is this real, and what should I do?`;
    case 'prolonged-idle':
      return `${id} has been stopped with the engine running. Breakdown or traffic?`;
    case 'harsh-braking':
      return `${id} triggered a hard braking event. Does this need a safety review?`;
    case 'hos-risk':
      return `${id} is running out of legal drive time. What are my options?`;
    case 'panic':
      return `${id} pressed the panic button. What do I do first?`;
    case 'geofence-breach':
      return `${id} left the geofence they should be inside. What should I check?`;
    default:
      // Nothing raised. The useful question is then about the clock, since
      // that is the only thing on this driver that changes without an event.
      return driver.hosRemainingMinutes <= 60
        ? `${id} is low on drive time. Can they finish the run?`
        : `Is there anything I should know about ${id}?`;
  }
}

function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${h}h${String(minutes % 60).padStart(2, '0')}`;
}
