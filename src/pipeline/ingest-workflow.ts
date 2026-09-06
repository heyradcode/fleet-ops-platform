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
  collectOne, normaliseAll, resolveTerritory, foldDriverState,
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
      // Concurrency 4 keeps us well inside every vendor's rate limit while
      // still cutting wall-clock time by roughly 4x.
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
      type: 'Task',
      name: 'ResolveTerritory',
      fn: (readings) => resolveTerritory(principal, readings),
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
