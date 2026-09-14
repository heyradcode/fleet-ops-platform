/**
 * The numbers the board shows, formatted the way an operations shift discusses
 * them.
 *
 * Small on purpose, and shared: the estate row, the device panel and the
 * utilisation strip all read the same thresholds, and two copies of the
 * threshold logic is how a strip ends up amber while the rule stays quiet.
 */
import { UTILISATION_THRESHOLDS } from '../../src/integrations/classify.ts';
import type { Alarm, DeviceRole, DeviceStatus } from '../../src/platform/types.ts';

/** The strip is scaled to full utilisation, so the fill is literally percent. */
export const UTILISATION_MAX = 100;

export type LoadLevel = 'warning' | 'critical' | null;

/**
 * The same thresholds the capacity rule uses, from the same constant. The strip
 * and the alarm are reading one number and cannot disagree.
 */
export function loadLevel(percent: number): LoadLevel {
  if (percent >= UTILISATION_THRESHOLDS.critical) return 'critical';
  if (percent >= UTILISATION_THRESHOLDS.warning) return 'warning';
  return null;
}

/**
 * How an alarm was witnessed, in a row's few words.
 *
 * Corroboration is two independent PLANES, not two feeds - a syslog line and
 * an SNMP trap from one switch are one witness talking twice. So "syslog +
 * trap" beside PAGED would have been a contradiction on screen: the feed count
 * was two, the witness count was one. The words have to follow the rule that
 * paged it.
 */
export function witness(alarm: Pick<Alarm, 'planes'>, paged: boolean): string {
  const names: Record<string, string> = {
    device: 'the device',
    controller: 'its controller',
    external: 'our probe',
  };
  const seen = alarm.planes.map((p) => names[p] ?? p);

  if (seen.length > 1) return seen.join(' + ') + ' agree';
  const [only] = seen;
  return paged ? only + ' + a second witness' : only + ' only';
}

/** 84 -> "84%". Trivial, but it keeps the unit in one place. */
export function formatPercent(value: number): string {
  return Math.round(value) + '%';
}

/**
 * Role, abbreviated to fit a dense row.
 *
 * Ordered by how much of the estate sits underneath, because that is the order
 * an operator triages in - and the abbreviations are the ones already written
 * on the rack labels.
 */
export function roleLabel(role: DeviceRole): string {
  const labels: Record<DeviceRole, string> = {
    'core': 'CORE',
    'distribution': 'DIST',
    'wan-edge': 'WAN',
    'firewall': 'FW',
    'access': 'ACC',
    'wireless-ap': 'AP',
  };
  return labels[role];
}

/** How urgent a device's own status is, for sorting the estate list. */
export function statusRank(status: DeviceStatus): number {
  const rank: Record<DeviceStatus, number> = {
    down: 0, degraded: 1, unknown: 2, healthy: 3,
  };
  return rank[status];
}
