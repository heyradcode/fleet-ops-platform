/**
 * Time for the mocks' ACTIVITY - calls, meetings, queue traffic.
 *
 * The directory is timeless, but activity has to sit near "now" or a client
 * asking for the last fifteen minutes finds nothing. So activity is generated
 * for a window ending at an ANCHOR: the injected clock, floored to five
 * minutes. Under the fixed demo clock the anchor never moves and every run is
 * identical; under the real clock (the Node server) the data follows the wall
 * clock and is regenerated, deterministically for that anchor, every five
 * minutes.
 *
 * Why floored rather than exact: regenerating per request would make two pages
 * of one drain come from two different datasets, and the drain would return
 * duplicates or gaps that are the mock's fault rather than the connector's.
 */
import { now } from '../../../platform/clock.ts';

export const ANCHOR_MS = 5 * 60 * 1000;
/** How far back activity goes. */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The planted incidents occupy the last this-many minutes before the anchor. */
export const PLANTED_WINDOW_MS = 40 * 60 * 1000;

export function activityAnchor(): number {
  return Math.floor(now() / ANCHOR_MS) * ANCHOR_MS;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Seconds as an ISO-8601 duration, the way Graph writes jitter and round-trip
 * time: `PT0.018S`. Kept as a string on purpose - see teams.ts.
 */
export function isoDuration(seconds: number): string {
  return 'PT' + String(Math.round(seconds * 1000) / 1000) + 'S';
}
