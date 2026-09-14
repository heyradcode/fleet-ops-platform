# Runbook: Capacity saturation

Applies to: sustained CPU or interface utilisation above 80% (warning) or 95%
(critical).

## Symptoms
A `capacity-saturation` alarm, raised from `cpu-utilisation` or
`interface-utilisation`. The board shows the device's load strip amber or red.

## Before you act: sustained, or a spike?
One sample above the line is not an alarm worth acting on. Control-plane CPU
spikes to 100% during a routing convergence, a large ACL push, or an SNMP walk
of a big table — all of them normal, all of them transient.

What matters is **duration and coincidence**:

1. Has it been above the line across several consecutive samples?
2. Is there an `interface-errors` alarm on the same device in the same window?
   Saturation plus errors is a story — the box is dropping traffic it cannot
   process. Either alone is usually noise.
3. Did a `config-change` land just before it started?

## What to check, in order
1. **Which** interface. An uplink at 95% is capacity planning; an access port
   at 95% is one host misbehaving.
2. Whether the utilisation is symmetric. Heavy inbound with light outbound on
   an access port is often a broadcast storm or a loop, not legitimate demand.
3. Flow records for the interface, if the estate exports IPFIX. This is what
   the flow archive is for — it is the only place that can tell you *what*
   traffic, and it is queried analytically rather than from the board.
4. On a wireless access point, check `ap-client-count` alongside CPU. Forty
   clients on one radio is a coverage problem, not a device problem.

## Escalate when
- A `core` or `wan-edge` interface has been above 80% for more than an hour
  during business hours. That is a capacity purchase, not an incident.
- CPU is pinned at 100% and the device has begun dropping its own control
  traffic — you will see adjacencies flapping alongside it.

## Do not
Do not reboot a saturated device to "clear" it. You will lose the evidence, the
traffic will return, and on a core box you will convert a degradation into an
outage.
