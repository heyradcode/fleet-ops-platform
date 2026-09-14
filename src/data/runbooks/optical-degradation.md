# Runbook: Optical degradation

Applies to: transceiver receive power below -14 dBm (warning) or -18 dBm
(critical).

## Symptoms
An `optical-degradation` alarm from an `optical-rx-power` reading. Often
accompanied by intermittent `link-state` flaps and rising `interface-errors` on
the same port.

## Read the sign correctly
Optical receive power is **negative**, and closer to zero is better. -3 dBm is
healthy; -18 dBm is nearly dark. A threshold comparison written the wrong way
round here does not throw — it simply never fires, and the platform silently
stops warning about dying optics.

The platform's severity rule treats this metric as inverted, along with
`reachability`. If you are changing thresholds, check that list first.

## Is it the optic, the fibre, or the far end?
1. Compare with the **far end's** receive power on the same span. Both ends low
   points at the fibre or a connector; one end low points at that end's optic.
2. Check whether the value is **drifting or stepped**. A slow drift over weeks
   is a transceiver ageing out. A sudden step is almost always physical — a
   patch panel disturbed, a connector knocked, a bend introduced.
3. Look for a recent `config-change` or maintenance record. A step change at
   exactly the time somebody was in the rack is not a coincidence.

## What to check, in order
1. Receive power at both ends.
2. Interface error counters — CRC errors climbing alongside falling optical
   power confirms the link is now marginal rather than merely dim.
3. Whether the port has flapped. A marginal optic that flaps drags routing
   convergence with it every time, which is worse for the network than a port
   that is cleanly down.

## Escalate when
- The reading is below -18 dBm on a `core`, `distribution` or `wan-edge` link.
  These are the spans whose failure takes a subtree with it.
- Power is falling measurably week on week. Schedule the replacement rather
  than waiting for the outage.

## Do not
Do not clean a connector without recording the before reading. Without it there
is no way to tell whether the clean helped or the fault simply moved.
