# Runbook: Link down

Applies to: any interface reporting an operational state other than `up`.

## Symptoms
A `link-state` event with state `down`, `lowerLayerDown` or `dormant`. On the
board the device shows an amber or red port count and the interface appears in
its detail panel.

## Before you act: is it real, and is it one event or four?
A single Cisco link failure normally arrives **four times**: `%LINK-3-UPDOWN`
and `%LINEPROTO-5-UPDOWN` over syslog, plus a `linkDown` SNMP trap, plus the
matching trap for the line protocol. All four come from the same agent on the
same chassis.

The platform collapses these on a shared dedupe key before the rules run, so
you should see one event with a `witnesses` count, not four. If you are looking
at four separate alarms for one port, the dedupe key is wrong — that is a bug,
not a busy network.

Four reports from one box is still **one witness**. What makes a link failure
real is a second vantage point:

1. Does the device at the **far end** report the same link down? Two chassis
   agreeing is genuine corroboration even though both are on the device plane.
2. Does the **controller** show the device offline or alerting?
3. Does the **probe** fail? This is the one that still works when the device
   has stopped talking altogether.

## What to check, in order
1. `state` — `lowerLayerDown` means the failure is UPSTREAM of this port. Do
   not troubleshoot this interface; find the alarm on the device above it.
2. `adminStatus` — if it is `down`, somebody shut the port deliberately. This
   is a change record, not an outage.
3. The `layer` attribute — `physical` is a cable, transceiver or far-end
   device. `protocol` alone, with physical still up, is usually a keepalive,
   duplex or encapsulation mismatch rather than a broken cable.
4. Optical receive power on the same interface, if the platform has it. A port
   that flaps with `optical-rx-power` drifting toward -18 dBm is a dying
   transceiver and will keep flapping until it is replaced.

## Escalate when
- The port is on a `core` or `distribution` device: the blast radius is the
  whole subtree beneath it.
- The same port has flapped more than three times in an hour. Intermittent is
  worse than down — it drags routing convergence with it each time.

## Do not
Do not clear or bounce the interface before recording the optical readings. The
evidence disappears when the link comes back, and you will be back here next
week with no history.
