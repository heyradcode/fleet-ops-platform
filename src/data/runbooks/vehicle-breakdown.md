# Runbook: Vehicle breakdown or prolonged idle

Applies to: any driver stationary with the engine running for more than 15
minutes (warning) or 30 minutes (critical), outside a known stop.

## Symptoms
An `idle` reading above threshold. Often paired with a route deviation, since a
driver who breaks down usually gets off the carriageway first.

## Read the pair, not the reading
Idle alone is frequently normal: loading docks, queues, rest breaks, traffic.
What makes it interesting is what it is paired with.

| Idle plus...          | Usually means                         |
|-----------------------|---------------------------------------|
| inside a geofence     | a normal stop. No action.             |
| route deviation       | a breakdown, or a diversion.          |
| several nearby drivers| a road closure, not a breakdown.      |
| low hours-of-service  | a legitimate rest break.              |
| nothing at all        | traffic. Wait for the next reading.   |

## Triage
1. Check whether the driver is inside a depot, customer or rest-stop geofence.
   If so, this is a normal stop that the plan did not know about; fix the plan.
2. Check whether other drivers nearby are also stopped. Several drivers
   stationary at the same point is a closure, and it will already have been
   merged into one incident.
3. Contact the driver. This is the one case where calling early is right - a
   breakdown gets worse with time and the driver may be somewhere unsafe.

## Resolution
- **Normal stop:** update the plan so it stops re-raising.
- **Traffic:** acknowledge, no action.
- **Breakdown:** confirm the driver is safe and off the carriageway first,
  before anything about the load. Then dispatch roadside assistance and decide
  on the load separately - those are two problems and the driver is the urgent
  one.
- **Load needs to move:** find relief with the nearby-available-drivers query.
  It filters on hours of service, so anything it returns can legally take it.

## Escalation
Escalate to roadside assistance immediately for any breakdown on a live
carriageway. Escalate to the operations lead if the load is time-critical and
no relief driver is within range.
