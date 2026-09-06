# Runbook: Access point down

Applies to: Aruba access points, Meraki MR series, Mist APs.

## Symptoms
Device health reported as zero, or vendor status Down. No CPU or radio metrics
are being reported at all - absence of telemetry is the signal.

## Triage
1. Determine whether it is one AP or a group. Several APs down together almost
   always means the upstream switch or the PoE budget, not the APs.
2. Check the upstream switch port: is it up, is PoE being delivered, has the
   power budget been exceeded by a recent install?
3. Check for a recent firmware push. A stuck upgrade leaves an AP unreachable
   but powered.

## Resolution
- Single AP, port up, PoE fine: remote reboot via the vendor cloud console.
- Multiple APs on one switch: investigate the switch. Check PoE budget before
  assuming hardware failure - adding six APs to a 370W switch is a common cause.
- Stuck firmware: roll back to the previous known-good version.

## Escalation
Dispatch a field engineer if a remote reboot fails twice. For a site with more
than 500 staff, dispatch immediately rather than retrying remotely.
