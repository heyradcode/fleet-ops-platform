/**
 * ---------------------------------------------------------------------------
 * Device detail, and the assistant
 * ---------------------------------------------------------------------------
 * The panel shows WHY, and it shows its working.
 *
 * Most AI features in products show only the final answer. This one shows the
 * tool calls as they happen - which query ran, which runbook was retrieved,
 * what was refused - because an engineer deciding whether to drive to a site at
 * 4am needs to know what the recommendation rests on. An answer with no visible
 * provenance is a thing to be sceptical of, and an engineer is right to be.
 *
 * It also makes the authorisation rule visible rather than asserted: a refused
 * tool appears in the trace, in red, with the reason. The agent acts with the
 * caller's permissions, and you can watch that happen.
 *
 * THE TOPOLOGY BLOCK IS THE ONE THAT CHANGES BEHAVIOUR. Everything else here
 * describes the box you clicked; the uplink chain tells you whether the box you
 * clicked is the problem at all. An engineer who starts troubleshooting an
 * access switch that is merely downstream of a dead distribution switch loses
 * the first twenty minutes of an outage, and that is the single most common way
 * a network incident goes badly.
 */
import { useEffect, useRef, useState } from 'react';
import { transport } from './transport/select.ts';
import { agentSource } from './agentSource.ts';
import { formatPercent, loadLevel, roleLabel, witness } from './format.ts';
import type { AgentResult, AgentTrace, Alarm, DeviceState } from './transport/index.ts';

type Props = {
  device: DeviceState;
  alarms: Alarm[];
  /** Alarm ids that made it into an incident - the rule's verdict. */
  paged: Set<string>;
  /** Devices between this one and its site root, nearest first. */
  upstream: DeviceState[];
  /** Everything that depends on this device. */
  downstream: DeviceState[];
  onSelect(deviceId: string): void;
  onClose(): void;
};

export function DevicePanel({
  device, alarms, paged, upstream, downstream, onSelect, onClose,
}: Props) {
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The steps as they arrive, while the answer is still being worked out.
  const [live, setLive] = useState<AgentTrace[]>([]);
  const traceEnd = useRef<HTMLDivElement>(null);

  // A new device is a new question. Carrying the previous answer over would be
  // worse than showing nothing: it looks like an answer about this device.
  useEffect(() => { setResult(null); setError(null); }, [device.deviceId]);

  useEffect(() => {
    traceEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [result]);

  const question = questionFor(device, alarms, upstream);
  const load = loadLevel(device.cpuUtilisation);

  // An alarm here while something above is ALSO alarming means this device is
  // probably a symptom. Saying so costs one line and saves the wrong call-out.
  const suspectUpstream = alarms.length > 0 && upstream.some((u) => u.status !== 'healthy');

  async function ask() {
    setAsking(true);
    setError(null);
    setLive([]);
    try {
      setResult(await transport.askAgent(question, (step) => setLive((prev) => [...prev, step])));
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
        <span>Device</span>
        <button className="panel-close" onClick={onClose} aria-label="Close device detail">
          ✕
        </button>
      </div>

      <div className="panel-body">
        <header className="panel-id">
          <span className="panel-name">{device.name}</span>
          <span className="mono panel-deviceid">{device.deviceId}</span>
        </header>

        <dl className="facts">
          <Fact label="Role" value={roleLabel(device.role)} />
          <Fact label="Vendor" value={device.vendor} />
          <Fact label="Site" value={device.siteId} />
          <Fact
            label="Status"
            value={device.status}
            tone={device.status === 'down' ? 'critical'
              : device.status === 'degraded' ? 'warning' : undefined}
          />
          <Fact
            label="Load"
            value={formatPercent(device.cpuUtilisation)}
            mono
            tone={load ?? undefined}
          />
          <Fact
            label="Ports down"
            value={String(device.interfacesDown)}
            mono
            tone={device.interfacesDown > 0 ? 'warning' : undefined}
          />
        </dl>

        <section className="panel-section">
          <h3 className="panel-h">Topology</h3>

          {suspectUpstream && (
            <p className="panel-suspect">
              Something upstream is also alarming. Check that first — this device
              may be a symptom.
            </p>
          )}

          <div className="topo">
            {upstream.length === 0
              ? <p className="topo-none">Site root. Nothing sits above this device.</p>
              : (
                <ol className="topo-chain">
                  {[...upstream].reverse().map((u) => (
                    <li key={u.deviceId}>
                      <button className={`topo-node is-${u.status}`} onClick={() => onSelect(u.deviceId)}>
                        <span className="topo-role">{roleLabel(u.role)}</span>
                        {u.name}
                      </button>
                    </li>
                  ))}
                  <li>
                    <span className="topo-node is-self">
                      <span className="topo-role">{roleLabel(device.role)}</span>
                      {device.name}
                    </span>
                  </li>
                </ol>
              )}

            <p className="topo-blast">
              {downstream.length === 0
                ? 'Nothing depends on this device.'
                : <><b>{downstream.length}</b> device{downstream.length === 1 ? '' : 's'} depend on it.</>}
            </p>
          </div>
        </section>

        {alarms.length > 0 && (
          <section className="panel-section">
            <h3 className="panel-h">Raised</h3>
            {alarms.map((a) => (
              <div key={a.alarmId} className="panel-alarm">
                <span className="alarm-kind">{a.kind.replace(/-/g, ' ')}</span>
                <span className="panel-witness">
                  {witness(a, paged.has(a.alarmId))}
                  {paged.has(a.alarmId) ? '' : ' — not corroborated'}
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
            <>
              {live.length > 0 && (
                <ol className="trace">{live.map((t) => <TraceStep key={t.step} step={t} />)}</ol>
              )}
              <p className="panel-working">
                <span className="pulse" aria-hidden="true" /> Working — retrieving runbooks,
                querying observations.
              </p>
            </>
          )}

          {error && (
            <p className="panel-error">
              {error} Try again, or read the device observations directly.
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
                {agentSource(result)}
              </p>

              <button className="ask" onClick={ask}>Ask again</button>
              {transport.newConversation && (
                <button className="linkish" onClick={() => { transport.newConversation!(); setResult(null); }}>
                  New conversation
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */

/** Exported for the comms view, whose assistant shows its working the same way. */
export function TraceStep({ step }: { step: AgentTrace }) {
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
 * A fixed "what is wrong with this device" is worse in two ways. It is worse
 * product design - an engineer who clicked an alarming device wants to ask
 * about the thing that alarmed, not a generic question - and it is worse
 * retrieval, because the runbook corpus is organised by alarm kind and a
 * generic question matches all of them weakly rather than one strongly.
 *
 * The upstream case takes priority over the device's own alarm, deliberately.
 * When something above is also unwell, the question worth asking is not "what
 * is wrong here" but "is this even the right box".
 *
 * Phrased the way an engineer would say it out loud, not the way the schema
 * spells it.
 */
function questionFor(device: DeviceState, alarms: Alarm[], upstream: DeviceState[]): string {
  const name = device.name;

  if (alarms.length > 0 && upstream.some((u) => u.status !== 'healthy')) {
    return `${name} is alarming but so is something above it. Which one should I look at?`;
  }

  switch (alarms[0]?.kind) {
    case 'link-down':
      return `A port on ${name} went down. Is this real, and what should I check?`;
    case 'device-unreachable':
      return `${name} has stopped responding. Is it the device or its uplink?`;
    case 'adjacency-lost':
      return `${name} lost a routing adjacency. What do I check first?`;
    case 'interface-errors':
      return `${name} is logging interface errors. Cable, optic, or load?`;
    case 'capacity-saturation':
      return `${name} is running hot. Is this sustained or a spike?`;
    case 'optical-degradation':
      return `Optical power on ${name} is falling. Do I replace the transceiver?`;
    case 'power-fault':
      return `${name} reported a power supply fault. What is the impact and what do I do?`;
    default:
      // Nothing raised. The useful question is then about load, since that is
      // the only thing on a healthy device that changes without an event.
      return loadLevel(device.cpuUtilisation)
        ? `${name} is running hot with no alarm. Should I be worried?`
        : `Is there anything I should know about ${name}?`;
  }
}
