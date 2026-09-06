# Runbook: Route deviation

Applies to: any driver whose position is more than 400m from the planned route
corridor for a sustained period.

## Symptoms
A `route-adherence` reading above 400m (warning) or 1000m (critical). On the
board the driver's pin sits visibly off the highlighted corridor.

## Before you act: is it real?
A single deviation reading, corroborated by nothing else, is usually GPS drift.
Cheap receivers lose fix under overpasses, in urban canyons and inside
warehouses, and a drifted position looks identical to a genuine detour.

The platform will not raise an incident for an uncorroborated deviation, and
you should apply the same rule by hand:

1. Is the vehicle also **stationary**? A driver who has left the route and
   stopped has almost certainly hit something - a closure, a breakdown, a
   queue. That is two independent signals and it is real.
2. Are **other drivers** on the same corridor deviating at the same point? If
   so this is not one driver's problem, it is a road closure, and it will
   already have been merged into a single incident covering all of them.
3. Does the deviation **persist** across several readings? One reading that
   snaps back is drift.

If none of those hold, do not call the driver. Interrupting someone to ask why
their GPS glitched is how drivers learn to ignore dispatch.

## Triage
1. Check the exception timeline for the driver. A deviation preceded by harsh
   braking suggests an incident; one preceded by a long idle suggests a
   planned stop that was not on the plan.
2. Look at the corridor, not just the point. A driver 800m off I-35E on the
   frontage road is following a diversion; a driver 800m off in a residential
   street is doing something else.
3. Check hours-of-service. A driver close to their limit may be routing to a
   rest stop, which is correct behaviour and should not be questioned.

## Resolution
- **Road closure affecting several drivers:** the incident already covers them
  all. Confirm the closure with the traffic feed, then re-plan the corridor
  once rather than calling fourteen people.
- **One driver, genuine detour:** contact the driver. Update the plan so the
  deviation stops re-raising.
- **Drift:** acknowledge and close. Note the vehicle id - a device that drifts
  repeatedly needs replacing, and that is a maintenance ticket, not a dispatch
  problem.

## Escalation
Escalate to the operations lead when a closure affects more than ten drivers or
is expected to last more than an hour, since that becomes a capacity problem
rather than a routing one.
