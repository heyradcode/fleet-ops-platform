# Runbook: Contact centre queue backlog

Applies to: Genesys Cloud, Five9 and Amazon Connect voice queues.

## Symptoms
Oldest waiting contact above 180 seconds, or abandon rate above 12 percent.
Agents-ready count is usually low at the same time.

## Triage
1. Check agents ready versus scheduled. A backlog with agents idle is a routing
   fault, not a staffing fault - look at the routing rules first.
2. Correlate against network signals for the same site. Agents on a site with
   WAN packet loss cannot take calls even when they are marked ready; their
   softphones drop registration silently.
3. Check whether the backlog is one queue or all queues. One queue points at
   skills or routing. All queues points at the carrier trunk or the site.

## Resolution
- Routing fault: widen the skill match or enable overflow to the secondary
  queue. This is reversible and takes effect within seconds.
- Network-induced: move affected agents to the backup site or to home working
  and let the network incident drive the fix.
- Genuine volume spike: open overflow to the outsourced partner queue and
  post a wait-time message to callers.

## Escalation
Escalate to the workforce management team if the backlog exceeds 20 minutes.
If network signals correlate, link this incident to the network incident rather
than working it separately - resolving the network resolves this.
