/**
 * ---------------------------------------------------------------------------
 * The transport boundary
 * ---------------------------------------------------------------------------
 * Everything in the board depends on THIS INTERFACE and nothing below it. That
 * is the whole design, and it is worth being precise about why it is not just
 * indirection for its own sake:
 *
 *   in-process   imports the resolvers directly and runs the entire backend
 *                inside the browser tab. No server, no network, no mocks.
 *   appsync      the real endpoint, over HTTPS and a WebSocket.
 *
 * The in-process implementation works because `src/aws/` is already a set of
 * local stand-ins for DynamoDB, S3, EventBridge, Step Functions and Bedrock,
 * and because the shared module graph contains no `node:` import. Neither of
 * those was done for the front end - they were done because they were right -
 * and this falls out of them.
 *
 * What that buys, beyond "the demo runs offline": it makes "the client depends
 * on the API contract, not the API implementation" a demonstrated fact rather
 * than an architectural claim. The board cannot reach around the contract
 * because there is nothing behind it to reach for.
 */
import type {
  Alarm, DeviceState, DeviceStatus, Incident, Principal, Site,
} from '../../../src/platform/types.ts';
import type { AgentResult } from '../../../src/ai/agent-core.ts';
import type { CommsAlarm, CommsIncident } from '../../../src/integrations/comms/incidents.ts';
import type { WorkforceSummary } from '../../../src/integrations/comms/store.ts';
import type { IntegrationHealth } from '../../../src/integrations/comms/health.ts';
import type { PhoneInventory } from '../../../src/integrations/comms/kurmi.ts';
import type { Brief } from '../../../src/reporting/daily-brief.ts';
import type { CommsAnomaly } from '../../../src/integrations/comms/anomalies.ts';

/**
 * The two views that read real data. Defined beside the handler that serves
 * them over HTTP (src/api/board-api.ts), so the API and every transport share
 * one contract rather than two copies of it.
 */
export type { BoardSnapshot, CommsSnapshot } from '../../../src/api/board-api.ts';
import type { BoardSnapshot, CommsSnapshot } from '../../../src/api/board-api.ts';

/**
 * One frame of the recorded half-hour.
 *
 * NOT positions. A fleet board replays movement; nothing in a network moves,
 * and a replay of switch coordinates would be sixty identical frames. What
 * changes here is STATE - specifically the shape of a failure spreading down
 * the topology - which is the thing an operator needs to see to believe that
 * forty devices going quiet is one event and not forty.
 */
export type HealthTick = {
  at: string;
  index: number;
  total: number;
  /** Only devices that are not healthy. Absent means healthy. */
  status: Map<string, DeviceStatus>;
  /** The device the cascade starts at, for the board to label. */
  rootCauseDeviceId: string;
};

export type Transport = {
  /**
   * Health replay.
   *
   * NOT a subscription in the AppSync sense, and the distinction is the
   * architecture: observations are never pushed. A real client polls state on a
   * coarse tick, because tens of thousands of records a second is not
   * information a human can use. This replays the recorded half-hour on that
   * cadence, which is what makes the board a product rather than a screenshot.
   */
  subscribeHealth(
    siteId: string | undefined,
    onTick: (tick: HealthTick) => void,
  ): () => void;

  /**
   * Install the signed-in session.
   *
   * A real GraphQL client does exactly this once, in an auth link, and every
   * request afterwards carries the token. Here it means the board reasons
   * about the principal the VERIFIER produced rather than one the UI made up -
   * which is what turns "a Dallas operator cannot see Phoenix" from a claim
   * into something you demonstrate by signing in as one.
   */
  // The access token is for transports that send it: the in-process one
  // ignores it, and the API one sends nothing else.
  setSession(principal: Principal | null, accessToken?: string | null): void;

  /** The board's first load, scoped to the caller's site. */
  loadBoard(siteId?: string): Promise<BoardSnapshot>;

  /**
   * The live feed. Only ALARMS arrive here - never observations.
   *
   * A syslog-heavy estate produces tens of thousands of records a second: more
   * than a human can use and more than anyone would pay to push. Device tiles
   * refresh on a coarse poll; this channel carries the handful of things that
   * need a decision.
   */
  subscribeAlarms(
    siteId: string | undefined,
    onAlarm: (alarm: Alarm) => void,
  ): () => void;

  /**
   * Ask the assistant about a device.
   *
   * No site argument, deliberately. The agent's reach comes from the caller's
   * TOKEN and the tools enforce it; a view parameter here would look like it
   * narrowed something when it could not.
   *
   * Returns the full trace, not just the answer, and that is a product decision
   * as much as a debugging one: an operator trusts a recommendation far more
   * when they can see which tools produced it and which runbook it came from.
   * An answer with no visible provenance is a thing to be sceptical of, and it
   * should be.
   */
  askAgent(question: string): Promise<AgentResult>;

  /**
   * The comms view, or null when this caller has none - their tenant runs no
   * comms sources, or their scope is narrower than tenant-wide. Null rather
   * than an empty snapshot, so the board can tell "nothing wrong" from
   * "not yours to see" and not offer a view it would have to leave blank.
   */
  loadComms(): Promise<CommsSnapshot | null>;
};

export type {
  AgentResult, Brief, CommsAlarm, CommsAnomaly, CommsIncident, IntegrationHealth, PhoneInventory, WorkforceSummary,
};
export type { AgentTrace } from '../../../src/ai/agent-core.ts';

export type { Alarm, DeviceState, DeviceStatus, Incident, Principal, Site };
