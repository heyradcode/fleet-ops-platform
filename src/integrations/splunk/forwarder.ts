/**
 * Splunk, wired to the event bus.
 *
 * THIS FILE IS DELIBERATELY SMALL, and its size is the argument for the bus.
 * Adding a whole new downstream system - one the customer already runs their
 * NOC on - is two rules and no change to anything that produces events. The
 * pipeline does not import Splunk, does not know it exists, and did not need
 * editing. That is what "producers do not know consumers" buys, and it is worth
 * pointing at the next time someone proposes calling a destination directly
 * from the code that generated the data.
 *
 * WHAT IS SUBSCRIBED, AND WHAT IS NOT:
 *
 *   AlarmRaised     yes - already filtered by the rules, small, and the thing
 *                   an operator wants to search beside their firewall logs
 *   IncidentOpened  yes - tiny, and what actually pages
 *   observations    NEVER REACH THE BUS AT ALL, so there is nothing to
 *                   subscribe to even if somebody wanted to. The architecture
 *                   makes the expensive mistake unavailable rather than merely
 *                   discouraged, which is the only kind of guardrail that holds.
 *
 * SEVERITY IS NOT FILTERED HERE. The pager rule takes criticals and the Slack
 * rule takes warnings, because waking someone is expensive. Splunk takes
 * everything that reached the bus, because the whole value of a log platform is
 * having the boring events present when you go looking six weeks later - and
 * filtering at write time is a decision you cannot undo.
 */
import type { EventBus } from '../../aws/eventbridge.ts';
import type { AlarmEventDetail, IncidentEventDetail } from '../../platform/types.ts';
import { alarmToHec, incidentToHec, send, hecConfig, type HecEvent } from './hec.ts';
import { log } from '../../platform/logger.ts';

/**
 * Buffer, then flush.
 *
 * A cascade raises a few dozen alarms within one execution, and one HTTPS round
 * trip each against a token-rate-limited indexer is both slow and rude. The bus
 * targets accumulate; `flushSplunk` sends. In production this buffer is the
 * Lambda's own batch - the rule target is an SQS queue with a batch window, and
 * the flush is the queue consumer.
 */
const pending: HecEvent[] = [];

export function registerSplunkForwarding(bus: EventBus): void {
  const config = hecConfig();

  bus.rule('alarms-to-splunk',
    { source: ['netpulse.evaluate'], detailType: ['AlarmRaised'] },
    (e) => {
      // The bus detail is deliberately flat and partial - EventBridge patterns
      // match on structure, so the producer keeps the filterable fields at the
      // top level rather than nesting the whole object. That means this target
      // shapes what it was given rather than re-reading the alarm, which would
      // be a DynamoDB GetItem per event on the hot path.
      pending.push(alarmToHec(e.detail as AlarmEventDetail, config.index));
    });

  bus.rule('incidents-to-splunk',
    { source: ['netpulse.detect'], detailType: ['IncidentOpened'] },
    (e) => {
      pending.push(incidentToHec(e.detail as IncidentEventDetail, config.index));
    });
}

/**
 * Ship whatever has accumulated.
 *
 * Returns the result rather than throwing, and the caller ignores it on the
 * happy path. A Splunk outage is not an ingest failure: the alarms are already
 * persisted, already on the bus, and already paged. See the note in hec.ts.
 */
export async function flushSplunk() {
  if (pending.length === 0) return { batches: 0, events: 0, failed: [] };

  const batch = pending.splice(0, pending.length);
  const result = await send(batch);

  if (result.failed.length > 0) {
    // In production these go to an SQS replay queue. Logged loudly here because
    // silently losing a customer's audit trail is the failure mode that only
    // surfaces during their next compliance review.
    log.warn('splunk events undelivered - queue for replay', { count: result.failed.length });
  }
  return result;
}

export function pendingSplunkCount(): number { return pending.length; }
export function resetSplunkBuffer(): void { pending.length = 0; }
