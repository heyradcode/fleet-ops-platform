/**
 * The numbers the board shows, formatted the way a shift is discussed.
 *
 * Small on purpose, and shared: the roster row, the driver panel and the
 * hours-of-service strip all read the same clock, and two copies of the
 * threshold logic is how a strip ends up amber while the rule stays quiet.
 */
import { HOS_THRESHOLD_MINUTES } from '../../src/integrations/connector.ts';

/** 11 hours is the US federal daily driving limit. The strip is scaled to it. */
export const HOS_MAX_MINUTES = 660;

export type HosLevel = 'warning' | 'critical' | null;

/**
 * The same thresholds the detection rule uses, from the same constant. The
 * strip and the alert are reading one number and cannot disagree.
 */
export function hosLevel(minutes: number): HosLevel {
  if (minutes <= HOS_THRESHOLD_MINUTES.critical) return 'critical';
  if (minutes <= HOS_THRESHOLD_MINUTES.warning) return 'warning';
  return null;
}

/** 128 -> "2h08". Hours and minutes, because that is how a shift is discussed. */
export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${String(m).padStart(2, '0')}`;
}
