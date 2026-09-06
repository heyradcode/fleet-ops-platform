/**
 * The state machine, assembled.
 *
 * Read this next to state-machine.asl.json - they are the same workflow, once
 * as runnable code and once as the Amazon States Language JSON that Terraform
 * actually deploys.
 */
import { StateMachine, type State } from '../aws/stepfunctions.ts';
import { connectors } from '../integrations/registry.ts';
import type { Principal } from '../platform/types.ts';
import {
  collectOne, normaliseAll, enrich, detectIncidents, publish,
  type PipelineInput,
} from './steps.ts';

export function buildIngestWorkflow(principal: Principal, since: string) {
  const input: PipelineInput = { principal, since };

  const states: State[] = [
    {
      type: 'Pass',
      name: 'PrepareConnectorList',
      transform: () => connectors,
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
      name: 'NormaliseToSignals',
      fn: (collected) => normaliseAll(collected),
      // Retry a transient failure twice, then give up. A normalise() bug will
      // not fix itself on retry, so the backoff is short by design.
      retry: { maxAttempts: 3, intervalMs: 50, backoffRate: 2 },
    },
    {
      type: 'Task',
      name: 'GeoEnrich',
      fn: (signals) => enrich(principal, signals),
      // Enrichment is a nice-to-have: a signal with no coordinates is still a
      // valid signal. Catch and continue rather than fail the execution.
      onError: 'continue',
    },
    {
      type: 'Choice',
      name: 'AnySignals',
      branches: [
        {
          when: (signals) => Array.isArray(signals) && signals.length > 0,
          then: [
            {
              type: 'Task',
              name: 'DetectIncidents',
              fn: (signals) => ({ signals, incidents: detectIncidents(principal, signals) }),
            },
            {
              type: 'Task',
              name: 'PersistAndPublish',
              fn: (payload: { signals: never[]; incidents: never[] }) =>
                publish(principal, payload.signals, payload.incidents),
              retry: { maxAttempts: 3, intervalMs: 100, backoffRate: 2 },
            },
          ],
        },
      ],
      // The empty-input path. Every workflow needs one, and forgetting it is
      // how you get a 3am page for a state machine that failed on a quiet night.
      otherwise: [
        { type: 'Pass', name: 'NothingToDo', transform: () => ({ signals: 0, incidents: 0 }) },
      ],
    },
  ];

  return new StateMachine('netpulse-ingest', states);
}
