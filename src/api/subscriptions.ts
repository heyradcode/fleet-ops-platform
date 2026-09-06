/**
 * ---------------------------------------------------------------------------
 * AppSync real-time subscriptions
 * ---------------------------------------------------------------------------
 * How they actually work - worth knowing, because it is not obvious:
 *
 *   1. The client opens a WebSocket to the real-time endpoint
 *      (wss://<api-id>.appsync-realtime-api.<region>.amazonaws.com/graphql)
 *      and sends a `start` message containing the subscription document and
 *      its arguments, plus the same auth header the HTTP endpoint uses.
 *   2. AppSync registers the subscription and remembers the ARGUMENTS as a
 *      FILTER.
 *   3. When a mutation named in @aws_subscription completes, AppSync takes the
 *      mutation's RETURN VALUE, matches it against every registered filter,
 *      and pushes it to the sockets that match.
 *
 * Consequences you should be able to state:
 *
 *   - The subscription payload is exactly the mutation's selection set. If the
 *     mutation did not return a field, subscribers cannot receive it - even if
 *     they asked for it. This surprises everyone once.
 *   - You cannot publish from arbitrary backend code by writing to DynamoDB.
 *     To push from a Lambda you must CALL THE MUTATION (usually with IAM auth).
 *     That is why `publishSignal` exists in the schema and is @aws_iam: the
 *     ingest pipeline calls it purely to trigger the subscription fan-out.
 *   - Filtering happens server-side, so a client watching one site is not
 *     billed for or woken by every other site's traffic.
 *   - Limits worth remembering: 100 subscriptions per connection, 240KB max
 *     payload, and a connection idle timeout you must handle by reconnecting.
 *
 * `enhancedSubscriptionFilters` (the newer, more powerful form) let you filter
 * on fields that are NOT subscription arguments, set from inside the mutation
 * resolver via `extensions.setSubscriptionFilter()`. Use it for things like
 * "only notify users whose region matches".
 */
import { log } from '../platform/logger.ts';

type Handler = (payload: unknown) => void;

type Registration = {
  id: number;
  field: string;
  /** The subscription's arguments, used as an equality filter. */
  filter: Record<string, unknown>;
  handler: Handler;
};

let nextId = 1;
const registrations: Registration[] = [];

/** Client side: `subscription { onIncidentOpened(severity: critical) { .. } }` */
export function subscribe(field: string, filter: Record<string, unknown>, handler: Handler): number {
  const id = nextId++;
  registrations.push({ id, field, filter, handler });
  log.debug('subscription registered', { field, filter, id });
  return id;
}

export function unsubscribe(id: number): void {
  const index = registrations.findIndex((r) => r.id === id);
  if (index >= 0) registrations.splice(index, 1);
}

/**
 * AppSync side: called with the mutation's return value. Every registration
 * whose filter matches gets the payload.
 */
export function publishToSubscribers(field: string, payload: Record<string, unknown>): number {
  const matched = registrations.filter(
    (r) => r.field === field && matchesFilter(r.filter, payload),
  );

  for (const r of matched) r.handler(payload);
  log.info('subscription fan-out ' + field, { subscribers: registrations.length, delivered: matched.length });
  return matched.length;
}

/** Undefined argument means "no filter on that field" - AppSync semantics. */
function matchesFilter(filter: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (v === undefined || v === null) return true;
    const actual = payload[k];
    return Array.isArray(actual) ? actual.includes(v) : actual === v;
  });
}

export function subscriberCount(): number { return registrations.length; }
