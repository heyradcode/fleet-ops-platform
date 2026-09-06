/**
 * The state machine, assembled.
 *
 * Read this next to state-machine.asl.json - they are the same workflow, once
 * as runnable code and once as the Amazon States Language JSON that Terraform
 * actually deploys.
 */
import { StateMachine, type State } from '../aws/stepfunctions.ts';
import { connectorsFor } from '../integrations/registry.ts';
import type { Driver, Exception, Principal, Telemetry } from '../platform/types.ts';
import {
  collectOne, normaliseAll, streamAndCollect, resolveTerritory, deriveRouteAdherence,
  foldDriverState,
  evaluate, detectIncidents, publish,
  type PipelineInput,
} from './steps.ts';

export function buildIngestWorkflow(principal: Principal, since: string) {
  const input: PipelineInput = { principal, since };

  const states: State[] = [
    {
      type: 'Pass',
      name: 'PrepareConnectorList',
      // Only the vendors this carrier actually runs - see registry.ts.
      transform: () => connectorsFor(principal),
    },
    {
      // Fan-out. In ASL this is a Map state with ItemsPath and MaxConcurrency.
      // Each iterator is a DIFFERENT vendor, so no single vendor's rate limit
      // is in play here; the cap bounds our own concurrency (and the Lambda
      // account limit it draws on), not theirs. Per-vendor limits belong in
      // the connector, where the retry and breaker already live.
      type: 'Map',
      name: 'CollectFromProviders',
      items: (cs) => cs,
      maxConcurrency: 4,
      iterator: (connector) => collectOne({ connector, input }),
    },
    {
      type: 'Task',
      name: 'NormaliseToTelemetry',
      fn: (collected) => normaliseAll(principal, collected),
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
      fn: (readings: Telemetry[]) => streamAndCollect(readings),
    },
    {
      type: 'Task',
      name: 'ResolveTerritory',
      fn: (readings) => deriveRouteAdherence(resolveTerritory(principal, readings)),
      // Resolution is a nice-to-have: a reading with no district is still a
      // valid reading, and an ELD never has coordinates at all. Catch and
      // continue rather than fail the execution.
      onError: 'continue',
    },
    {
      type: 'Choice',
      name: 'AnyTelemetry',
      branches: [
        {
          when: (readings) => Array.isArray(readings) && readings.length > 0,
          then: [
            {
              // Fold position and hours-of-service into the hot-state item, and
              // run the deterministic rules. Both read the same batch, which is
              // why they share a state rather than making two passes over it.
              type: 'Task',
              name: 'EvaluateRules',
              fn: (readings: Telemetry[]) => ({
                readings,
                drivers: foldDriverState(principal, readings),
                exceptions: evaluate(principal, readings),
              }),
            },
            {
              type: 'Task',
              name: 'DetectIncidents',
              fn: (payload: { readings: Telemetry[]; drivers: Driver[]; exceptions: Exception[] }) => ({
                ...payload,
                incidents: detectIncidents(principal, payload.exceptions),
              }),
            },
            {
              type: 'Task',
              name: 'PersistAndPublish',
              fn: (payload: {
                readings: Telemetry[]; drivers: Driver[];
                exceptions: Exception[]; incidents: never[];
              }) => publish(
                principal, payload.readings, payload.drivers,
                payload.exceptions, payload.incidents,
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
          transform: () => ({ telemetry: 0, drivers: 0, exceptions: 0, incidents: 0 }),
        },
      ],
    },
  ];

  return new StateMachine('meridian-ingest', states);
}
