/**
 * ---------------------------------------------------------------------------
 * EventBridge - the platform's nervous system
 * ---------------------------------------------------------------------------
 * Why an event bus instead of Lambda-calls-Lambda?
 *
 *   - Producers do not know consumers. Adding "also send a Slack message when
 *     an incident opens" is a new RULE, not a code change to the producer.
 *   - Rules filter on CONTENT, in the bus, before any Lambda is invoked. You
 *     do not pay to start a function that immediately decides "not for me".
 *   - Failures are per-target, with per-target retry and a dead-letter queue.
 *
 * Real call:
 *   await client.send(new PutEventsCommand({ Entries: [{
 *     EventBusName, Source: 'netpulse.ingest', DetailType: 'SignalNormalized',
 *     Detail: JSON.stringify(detail),
 *   }]}));
 *
 * Real rule (see infra/terraform/modules/eventbridge):
 *   { "source": ["netpulse.detect"],
 *     "detail-type": ["IncidentOpened"],
 *     "detail": { "severity": ["critical"] } }
 */
import { log } from '../platform/logger.ts';

export type EventEnvelope<T = unknown> = {
  source: string;          // e.g. 'netpulse.ingest'
  detailType: string;      // e.g. 'SignalNormalized'
  detail: T;
  time: string;
};

/** An EventBridge pattern: arrays mean "any of", nesting mirrors the detail. */
export type EventPattern = {
  source?: string[];
  detailType?: string[];
  detail?: Record<string, unknown>;
};

type Rule = {
  name: string;
  pattern: EventPattern;
  target: (e: EventEnvelope<any>) => Promise<void> | void;
};

export class EventBus {
  readonly name: string;
  #rules: Rule[] = [];
  /** Events whose target threw after retries. In AWS this is an SQS DLQ. */
  readonly deadLetterQueue: Array<{ event: EventEnvelope; error: string }> = [];
  published = 0;

  constructor(name: string) { this.name = name; }

  /** aws_cloudwatch_event_rule + aws_cloudwatch_event_target, in one call. */
  rule(name: string, pattern: EventPattern, target: Rule['target']): void {
    this.#rules.push({ name, pattern, target });
  }

  async putEvents(...events: Array<Omit<EventEnvelope, 'time'>>): Promise<void> {
    for (const e of events) {
      const envelope: EventEnvelope = { ...e, time: new Date().toISOString() };
      this.published++;
      const matched = this.#rules.filter((r) => matches(r.pattern, envelope));
      log.info('event ' + envelope.detailType, { source: envelope.source, matchedRules: matched.length });

      // Targets are independent: one failing must not block the others.
      await Promise.all(matched.map(async (r) => {
        try {
          await r.target(envelope);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('rule ' + r.name + ' target failed -> DLQ', { error: msg });
          this.deadLetterQueue.push({ event: envelope, error: msg });
        }
      }));
    }
  }
}

/** Simplified EventBridge pattern matcher: exact values, "any of" via arrays. */
export function matches(pattern: EventPattern, event: EventEnvelope): boolean {
  if (pattern.source && !pattern.source.includes(event.source)) return false;
  if (pattern.detailType && !pattern.detailType.includes(event.detailType)) return false;
  if (pattern.detail && !matchDetail(pattern.detail, event.detail as Record<string, unknown>)) return false;
  return true;
}

function matchDetail(pattern: Record<string, unknown>, detail: Record<string, unknown> | undefined): boolean {
  if (!detail) return false;
  return Object.entries(pattern).every(([k, want]) => {
    const got = detail[k];
    if (Array.isArray(want)) return want.includes(got as never);
    if (want && typeof want === 'object') {
      return matchDetail(want as Record<string, unknown>, got as Record<string, unknown>);
    }
    return got === want;
  });
}

export const bus = new EventBus(process.env.EVENT_BUS_NAME ?? 'netpulse-dev-bus');
