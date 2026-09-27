/**
 * ---------------------------------------------------------------------------
 * The agent's ITSM tool: "did anyone change anything?"
 * ---------------------------------------------------------------------------
 * The Incident Agent's half of the deck's "Helix + SolarWinds correlation":
 * the topology says what a device depends on, Helix says what was changed,
 * and this tool asks the second question along the first.
 *
 * READ-ONLY, and offered per tenant - only where Helix is configured AND a
 * client is wired. A tool that always answers "not configured" teaches a
 * model to stop trusting the tool list; the same reasoning as the comms tools.
 *
 * SCOPE IS THE CALLER'S, through `deviceState` - unlike the comms tools, a
 * network device HAS a site, so a Dallas operator can ask about Dallas boxes
 * and gets an error for anyone else's.
 */
import type { ToolSpec } from '../aws/bedrock.ts';
import type { Principal } from '../platform/types.ts';
import type { Tool } from './tools.ts';
import { allDeviceStates, deviceState } from '../geo/device-repository.ts';
import { now } from '../platform/clock.ts';
import { commsConfigFor } from '../integrations/comms/config.ts';
import { helixClientFor } from '../integrations/comms/helix.ts';
import { changesAroundDevice, describeDeviceChange } from '../integrations/comms/helix-network.ts';

export const ITSM_TOOLS: Tool[] = [
  {
    spec: {
      name: 'recentChanges',
      description:
        'List recent change records from Helix (the ITSM system) on a network device AND on every ' +
        'device upstream of it along its uplink chain, with how long before now each ended. Use ' +
        'this whenever a device has failed or degraded, BEFORE recommending a fix or a rollback: ' +
        'a recent change on the device or above it is the first candidate cause. Results are ' +
        'candidates, never established causes.',
      input_schema: {
        type: 'object',
        properties: { deviceId: { type: 'string', description: 'Device id such as dev-dis-dal01-04.' } },
        required: ['deviceId'],
      },
    },
    async execute(input, principal) {
      const deviceId = String(input.deviceId);
      if (!deviceState(principal, deviceId)) {
        const sample = allDeviceStates(principal).slice(0, 5).map((d) => d.deviceId).join(', ');
        return 'ERROR: unknown or out-of-scope deviceId "' + deviceId + '". Valid ids include: ' + sample + '.';
      }
      const r = await changesAroundDevice(principal, deviceId, now());
      if (r.status !== 'ok') return r.note;
      const head = 'Checked Helix for ' + r.chain.length + ' device(s): ' + r.chain.join(' -> ') + ' (the device, then up its uplinks).';
      if (r.changes.length === 0) {
        return head + '\nNo change on any of them in the last two hours. That rules out a recent change on this ' +
          'chain as the cause; it says nothing about devices elsewhere.';
      }
      return [head, ...r.changes.map((c) => '  ' + describeDeviceChange(c)),
        'Changes on SIBLING devices are deliberately not listed: a shared parent is not a shared cause.'].join('\n');
    },
  },
];

/** Offered only where Helix is configured and a client is wired for the tenant. */
export function itsmToolsFor(principal: Principal): ToolSpec[] {
  const ready = !!commsConfigFor(principal.tenantId)?.helix && !!helixClientFor(principal.tenantId);
  return ready ? ITSM_TOOLS.map((t) => t.spec) : [];
}
