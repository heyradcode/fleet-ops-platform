# Runbook: Hours-of-service risk

Applies to: any driver with fewer than 60 minutes of legal drive time remaining
(warning) or fewer than 40 (critical).

## Why this one is different
Hours of service is not a sensor reading. It is a legally mandated,
tamper-evident record from the ELD, and a truck carries exactly one. There is
no second device to corroborate it and none is needed - the platform escalates
this on a single source, deliberately.

Treat the number as authoritative. If a driver disputes it, that is an ELD
malfunction report, not a dispatch judgement call.

## Symptoms
An `hos-remaining` reading below threshold. Note the severity is **inverted**:
fewer minutes is worse. A reading of 20 is critical; a reading of 300 is fine.

## Triage
1. How far is the driver from the end of their run? Remaining drive time
   against remaining distance is the only question that matters.
2. Where is the nearest legal parking? A driver who times out on a highway
   shoulder is a safety problem and a compliance violation at once.
3. Is there an available driver nearby who could take the load? "Available"
   means on duty AND with enough hours to finish the run - the platform's
   nearby-driver query already applies both filters, so anything it returns is
   a legitimate option.

## Resolution
- **Enough time to finish:** no action. Note it and move on.
- **Not enough time, relief available:** reassign. The workflow validates
  eligibility, notifies both drivers, updates the plan and emits the event; do
  not shortcut it with a phone call, because the plan and the ELD records have
  to agree afterwards.
- **Not enough time, no relief:** direct the driver to the nearest rest stop
  and re-plan the remainder for the next shift. A late load is a commercial
  problem. A driver over their hours is a regulatory one, and they are not
  comparable.

## What you must never do
Do not ask a driver to "just finish the run" when the clock says they cannot.
The ELD record is evidence, the violation attaches to the carrier as well as
the driver, and the request is on the dispatch record too.

## Escalation
Escalate to the compliance team on any actual violation, same day. Escalate to
the operations lead when more than three drivers in a district are at risk in
one shift - that is a rostering fault, not a series of individual incidents.
