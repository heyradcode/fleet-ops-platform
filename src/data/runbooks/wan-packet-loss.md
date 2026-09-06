# Runbook: WAN packet loss above 5%

Applies to: MX security appliances, SD-WAN edge routers, any site reporting
packet loss on the primary WAN uplink.

## Symptoms
Packet loss above 5 percent sustained for more than five minutes, usually
paired with latency above 250ms. Voice quality degrades first; users report
choppy calls before they report anything else.

## Triage
1. Confirm the loss is on the WAN uplink, not the LAN. Compare the Meraki
   device loss figure against the ThousandEyes agent at the same site. If only
   ThousandEyes sees loss, the problem is beyond your demarcation point.
2. Check whether the secondary uplink is healthy. If it is, force a failover
   and confirm loss clears - that isolates the fault to the primary circuit.
3. Pull the last 30 minutes of interface error counters. Rising CRC errors
   point to a physical layer fault: bad SFP, damaged fibre, or a dirty patch.

## Resolution
- If the secondary circuit is clean: fail over, then raise a carrier ticket on
  the primary with the loss and latency figures attached.
- If both circuits show loss: the fault is upstream at the carrier aggregation
  point. Escalate immediately to the carrier NOC as a P2.
- If CRC errors are rising: dispatch a field engineer to reseat and clean the
  optics. Do not fail over first - a dirty SFP on the primary often means the
  secondary shares the same patch panel.

## Escalation
Escalate to the carrier NOC if loss persists past 15 minutes after failover.
Notify the site contact if the site has more than 500 staff.
