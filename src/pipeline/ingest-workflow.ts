/**
 * The state machine, assembled.
 *
 * Read this next to state-machine.asl.json - they are the same workflow, once
 * as runnable code and once as the Amazon States Language JSON that Terraform
 * actually deploys.
 *
 * NOTE WHAT IS AND IS NOT IN HERE. This workflow owns the POLL half and the
 * rules: call each cloud on a schedule, run the probe, fold in whatever
 * webhooks have arrived since, then evaluate and correlate.
 *
 * Webhook ARRIVAL is not a step at all. Deliveries hit API Gateway whenever a
 * vendor's cloud decides to send one, are signature-verified at the edge, and
 * are handed in here already unwrapped. Modelling them as a Map state would
 * imply a cadence they do not have - and would put a public HTTPS endpoint's
 * latency inside a scheduled execution, which is exactly the coupling the two
 * paths exist to avoid.
 */
import { StateMachine, type State } from '../aws/stepfunctions.ts';
import { connectorsFor } from '../integrations/controller/registry.ts';
import type { RawBatch } from '../integrations/http.ts';
import type { Alarm, DeviceState, Observation, Principal } from '../platform/types.ts';
import { getInventory } from '../geo/device-repository.ts';
import {
  collectOne, collectProbes, normaliseControllers, normaliseWebhooks,
  streamAndCollect, collapseDuplicates, resolveLocations, foldDeviceState,
  evaluate, detectIncidents, publish,
  type PipelineInput,
} from './steps.ts';

export function buildIngestWorkflow(
  principal: Principal,
  since: string,
  pushed: RawBatch[] = [],
) {
  const input: PipelineInput = { principal, since };
  const inventory = getInventory(principal);

  const states: State[] = [
    {
      type: 'Pass',
      name: 'PrepareControllerList',
      // Only the controllers this customer actually runs - see registry.ts.
      transform: () => connectorsFor(principal),
    },
    {
      // Fan-out. In ASL this is a Map state with ItemsPath and MaxConcurrency.
      // Each iterator is a DIFFERENT controller, so no single vendor's rate
      // limit is in play here; the cap bounds our own concurrency (and the
      // Lambda account limit it draws on), not theirs. Per-controller limits
      // belong in the connector, where the retry and breaker already live.
      type: 'Map',
      name: 'PollControllers',
      items: (cs) => cs,
      maxConcurrency: 4,
      iterator: (connector) => collectOne({ connector, input }),
    },
    {
      type: 'Task',
      name: 'NormaliseToObservations',
      fn: (collected) => {
        // Three sources, one canonical shape, three different planes. This is
        // the only place in the platform where they meet, and everything after
        // it is plane-agnostic except the corroboration rule - which is the
        // one place that must not be.
        //
        // Note that the webhook half is NOT a step here. Deliveries arrive at
        // API Gateway whenever the cloud feels like sending them, and modelling
        // them as a state in a scheduled workflow would imply a cadence they do
        // not have. They are passed in already verified; see webhook.ts.
        const fromControllers = normaliseControllers(principal, inventory, collected);
        const fromWebhooks = normaliseWebhooks(principal, inventory, pushed).observations;
        const fromProbe = collectProbes(principal, inventory);
        return [...fromWebhooks, ...fromControllers, ...fromProbe];
      },
      // Retry a transient failure twice, then give up. A normalise() bug will
      // not fix itself on retry, so the backoff is short by design.
      retry: { maxAttempts: 3, intervalMs: 50, backoffRate: 2 },
    },
    {
      // The stream. In production this is not a Step Functions state at all -
      // it is a PutRecords from the producer and an event-source mapping that
      // invokes the consumer independently. Modelling it inline keeps the whole
      // path visible in one execution history.
      type: 'Task',
      name: 'StreamAndBatch',
      fn: (observations: Observation[]) => streamAndCollect(observations),
    },
    {
      type: 'Task',
      name: 'EnrichAndDeduplicate',
      fn: (observations: Observation[]) =>
        resolveLocations(principal, collapseDuplicates(observations)),
      // Enrichment is a nice-to-have: an observation with no site is still a
      // valid observation, and a trap from a device we have only just
      // discovered has none. Catch and continue rather than fail the execution.
      onError: 'continue',
    },
    {
      type: 'Choice',
      name: 'AnyObservations',
      branches: [
        {
          when: (observations) => Array.isArray(observations) && observations.length > 0,
          then: [
            {
              // Fold status and load into the hot-state item, and run the
              // deterministic rules. Both read the same batch, which is why
              // they share a state rather than making two passes over it.
              type: 'Task',
              name: 'EvaluateRules',
              fn: (observations: Observation[]) => ({
                observations,
                devices: foldDeviceState(principal, observations),
                alarms: evaluate(principal, observations),
              }),
            },
            {
              type: 'Task',
              name: 'CorrelateIncidents',
              fn: (payload: { observations: Observation[]; devices: DeviceState[]; alarms: Alarm[] }) => ({
                ...payload,
                incidents: detectIncidents(principal, payload.alarms),
              }),
            },
            {
              type: 'Task',
              name: 'PersistAndPublish',
              fn: (payload: {
                observations: Observation[]; devices: DeviceState[];
                alarms: Alarm[]; incidents: never[];
              }) => publish(
                principal, payload.observations, payload.devices,
                payload.alarms, payload.incidents,
              ),
              retry: { maxAttempts: 3, intervalMs: 100, backoffRate: 2 },
            },
          ],
        },
      ],
      // The empty-input path. Every workflow needs one, and forgetting it is
      // how you get a 3am page for a state machine that failed on a quiet night.
      otherwise: [
        {
          type: 'Pass',
          name: 'NothingToDo',
          transform: () => ({ observations: 0, devices: 0, alarms: 0, incidents: 0 }),
        },
      ],
    },
  ];

  return new StateMachine('netpulse-ingest', states);
}
