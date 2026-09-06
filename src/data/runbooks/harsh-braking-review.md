# Runbook: Harsh braking event review

Applies to: any driver with a deceleration reading above 0.35g (warning) or
0.55g (critical), from telematics or dashcam.

## Symptoms
A `harsh-brake` reading, usually with a dashcam clip attached. Severity is the
peak g-force on the trigger.

## Before you act: who saw it?
A single accelerometer reading is weak evidence. Accelerometers trigger on
potholes, kerbs, and being loaded by a forklift, and a truck's suspension makes
this worse rather than better.

Check whether **two independent devices** agree. The telematics unit and the
dashcam are different hardware from different vendors; when both report the
same event at the same instant, something physical happened. When only one
does, it is very likely a sensor artefact.

The platform applies this rule before raising an incident. If you are looking
at a raised incident, corroboration has already been established - go straight
to triage.

## Triage
1. **Watch the clip before forming a view.** A hard stop for a cyclist is
   good driving that happens to look identical to a hard stop for inattention.
   The telemetry cannot tell them apart and neither can you without the video.
2. Check what preceded it. Following distance and speed in the seconds before
   the event tell you whether this was avoidable.
3. Check the driver's recent history. One event is noise. A pattern over weeks
   is a coaching conversation.
4. Check hours-of-service. Harsh events cluster near the end of long shifts,
   and if that is the pattern, the fix is rostering rather than coaching.

## Resolution
- **Avoidance of a genuine hazard:** log it, take no action, and tell the
  driver you looked and that they did the right thing. Drivers know when
  events are recorded; silence reads as suspicion.
- **Avoidable, isolated:** note it. No conversation for a single event.
- **Avoidable, repeated:** book coaching. Bring the clips.
- **Sensor artefact:** dismiss. If one vehicle produces these repeatedly, raise
  a maintenance ticket against the device.

## What this data is not for
Harsh-braking counts are not a performance metric and must not be used as one.
Ranking drivers on them teaches drivers to brake late and coast into hazards,
which makes the fleet less safe while making the number look better.

## Escalation
Escalate to the safety team on any event above 0.8g, any event with a
collision indication, and any driver with three or more corroborated events in
a rolling thirty days.
