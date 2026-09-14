# Runbook: Device unreachable

Applies to: any device whose `reachability` observation is 0.

## Symptoms
A `device-unreachable` alarm. The device's tile on the board goes dark rather
than red — it is not reporting anything at all, which is a different condition
from reporting a problem.

## The thing to understand first
A device that is powered off, wedged, or cut off behind a failed uplink
**cannot report its own failure**. Silence is not an observation. This is the
one alarm class where the device plane is guaranteed to tell you nothing, and
it is the entire reason the platform runs its own probe and polls the vendors'
controllers.

So the evidence for this alarm is always second-hand:

- the **controller** says the device stopped checking in, and
- our **probe** cannot reach its management address.

If only one of those is present, treat it with suspicion. A controller can lose
a device because the controller's own API is degraded; a probe can fail because
of a firewall change on the path rather than anything wrong with the target.

## Is it this device, or something above it?
Check the `rootCauseDeviceId` on the incident before touching anything. If
several devices went unreachable together and they share an uplink, **the
uplink is the fault** and the rest are symptoms. The platform will already have
merged them into one incident naming the device to go and look at.

If you are holding forty separate pages for one dead switch, correlation did
not run — check whether the alarms landed inside the ten-minute merge window.

## What to check, in order
1. Is there a `power-supply` event from the same device just before it went
   quiet? That is your answer, and it is a hardware dispatch.
2. Is the uplink device healthy? Walk up the chain, not down.
3. Was there a `config-change` on the uplink in the preceding minutes? An
   access-list or VLAN change that isolates a management subnet looks exactly
   like a dead device.
4. Only then consider the device itself.

## Escalate when
- The device is a `core` or `wan-edge` box.
- The site has no cloud controller. That estate has only two planes available,
  and a probe failure on its own is thin evidence to act on at 4am.
