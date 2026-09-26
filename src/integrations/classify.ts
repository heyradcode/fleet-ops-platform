/**
 * Severity: one rule, applied to every vendor.
 *
 * WHY WE THROW AWAY THE VENDOR'S OWN SEVERITY, which every cloud here supplies.
 *
 * All three rank their alerts, and the rankings are not comparable. Meraki has
 * one scale for its dashboard, Mist another for its alarm feed, and Central a
 * third; each is tuned to make that vendor's own console feel calm, which is a
 * product decision made by somebody optimising for a different screen.
 * Aggregating them produces a pile of incomparable colours that means nothing
 * across a mixed estate - which defeats the entire point of normalising.
 *
 * It is worse than merely inconsistent. A vendor has a commercial reason to
 * under-rank a fault in its own hardware and no reason at all to rank a fault
 * in somebody else's, so accepting their number quietly imports that bias into
 * a board whose whole job is comparing across vendors.
 *
 * So we derive it here, from thresholds we control. The connectors still keep
 * the vendor's own value in `attributes` - it is useful when debugging why a
 * cloud said something - but nothing reads it for a decision.
 */
import type { EventKind, MetricKind, Severity } from '../platform/types.ts';

/**
 * The utilisation thresholds, in percent.
 *
 * Exported because three other places have to agree with the rule: the
 * capacity-saturation alarm, the agent's advice about what counts as sustained
 * load, and the board's utilisation strip, which turns amber and red at exactly
 * these values. One constant, so they cannot drift - a strip that goes amber at
 * 60 while the rule fires at 80 is a board nobody trusts.
 */
export const UTILISATION_THRESHOLDS = { warning: 80, critical: 95 } as const;

/**
 * [warning, critical] per metric.
 *
 * Two of these count DOWNWARDS and getting that backwards is the classic silent
 * failure: the platform simply never warns, and looks healthy while doing it.
 * They are listed together and flagged rather than left to be inferred.
 */
const METRIC_THRESHOLDS: Record<MetricKind, [warning: number, critical: number]> = {
  // INVERTED: 1 reachable, 0 is the failure. [0, 0], NOT [1, 1]: with an
  // inverted `value <= critical` test, [1, 1] made every REACHABLE device
  // critical - invisible to the alarm rules (they test value === 0) but
  // painted on the map and handed to the agent as critical evidence.
  'reachability': [0, 0],
  'optical-rx-power': [-14, -18],     // INVERTED: dBm, more negative is worse
  'cpu-utilisation': [UTILISATION_THRESHOLDS.warning, UTILISATION_THRESHOLDS.critical],
  'memory-utilisation': [80, 95],     // percent
  'interface-utilisation': [UTILISATION_THRESHOLDS.warning, UTILISATION_THRESHOLDS.critical],
  'interface-errors': [100, 1_000],   // errors in the sample interval
  'wan-latency': [150, 300],          // ms
  'packet-loss': [1, 5],              // percent - 1% is already audible on voice
  'ap-client-count': [40, 60],        // associated clients on one radio
};

/** Metrics where a SMALLER number is worse. Kept as data, not as an if-chain. */
const INVERTED: MetricKind[] = ['reachability', 'optical-rx-power'];

export function severityForMetric(kind: MetricKind, value: number): Severity {
  const [warn, crit] = METRIC_THRESHOLDS[kind];

  if (INVERTED.includes(kind)) {
    if (value <= crit) return 'critical';
    if (value <= warn) return 'warning';
    return 'ok';
  }

  if (value >= crit) return 'critical';
  if (value >= warn) return 'warning';
  return 'ok';
}

/**
 * Severity for a discrete event.
 *
 * Keyed by kind AND state, because the transition is the whole content of the
 * record: a link going down and the same link coming back are one kind and two
 * very different pieces of news. A state we do not recognise gets 'info' rather
 * than a guess - unknown is not the same as unimportant, but it is certainly
 * not the same as critical, and inventing urgency is how a board loses trust.
 *
 * Note what is NOT here: any weighting by device role. A core switch failing
 * matters more than an access port, but that is a property of the topology and
 * belongs in correlation, where the uplink graph lives. Baking it in here would
 * mean the same event carried a different severity depending on where it was
 * raised, which makes the field impossible to reason about.
 */
const EVENT_SEVERITY: Record<EventKind, Record<string, Severity>> = {
  'link-state': { down: 'critical', up: 'info' },
  'protocol-adjacency': { lost: 'critical', established: 'info' },
  'power-supply': { failed: 'critical', restored: 'info' },
  'device-restart': { unexpected: 'critical', planned: 'info' },
  'radio-state': { down: 'warning', up: 'info' },
  'auth-failure': { rejected: 'warning', 'server-timeout': 'warning' },
  'config-change': { committed: 'info' },
};

export function severityForEvent(kind: EventKind, state: string): Severity {
  return EVENT_SEVERITY[kind][state] ?? 'info';
}
