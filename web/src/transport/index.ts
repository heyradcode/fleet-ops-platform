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
 * and because Phase 1 of the migration removed every `node:` import from the
 * shared module graph. Neither of those was done for the front end - they were
 * done because they were right - and this falls out of them.
 *
 * What that buys, beyond "the demo runs offline": it makes "the client depends
 * on the API contract, not the API implementation" a demonstrated fact rather
 * than an architectural claim. The board cannot reach around the contract
 * because there is nothing behind it to reach for.
 */
import type {
  Driver, Exception, Incident, Principal, Territory,
} from '../../../src/platform/types.ts';
import type { AgentResult } from '../../../src/ai/agent-core.ts';

export type BoardSnapshot = {
  drivers: Driver[];
  territories: Territory[];
  exceptions: Exception[];
  incidents: Incident[];
  /** Exceptions that fired but were not corroborated, so nobody was paged. */
  heldBack: Exception[];
};

/** One tick of position replay: where every in-scope driver is at that instant. */
export type PositionTick = {
  at: string;
  index: number;
  total: number;
  positions: Map<string, { lon: number; lat: number; status: Driver['status'] }>;
};

export type Transport = {
  /**
   * Position replay.
   *
   * NOT a subscription in the AppSync sense, and the distinction is the
   * architecture: positions are never pushed. A real client polls them on a
   * coarse tick, because 11,000 readings/sec of pin movement is not information
   * a human can use. This replays the seeded 30-minute trace on that cadence,
   * which is what makes the board a product rather than a screenshot.
   */
  subscribePositions(
    districtId: string | undefined,
    onTick: (tick: PositionTick) => void,
  ): () => void;

  /**
   * Install the signed-in session.
   *
   * A real GraphQL client does exactly this once, in an auth link, and every
   * request afterwards carries the token. Here it means the board reasons
   * about the principal the VERIFIER produced rather than one the UI made up -
   * which is what turns "a Dallas dispatcher cannot see Phoenix" from a claim
   * into something you demonstrate by signing in as one.
   */
  setSession(principal: Principal | null): void;

  /** The board's first load, scoped to the caller's district. */
  loadBoard(districtId?: string): Promise<BoardSnapshot>;

  /**
   * The live feed. Only EXCEPTIONS arrive here - never telemetry.
   *
   * At 330k drivers, positions are ~11,000 readings/sec: more than a human can
   * use and more than anyone would pay to push. Pins refresh on a coarse poll;
   * this channel carries the handful of things that need a decision.
   */
  subscribeExceptions(
    districtId: string | undefined,
    onException: (exception: Exception) => void,
  ): () => void;

  /**
   * Ask the assistant about a driver.
   *
   * Returns the full trace, not just the answer, and that is a product
   * decision as much as a debugging one: a dispatcher trusts a recommendation
   * far more when they can see which tools produced it and which runbook it
   * came from. An answer with no visible provenance is a thing to be sceptical
   * of, and it should be.
   */
  askAgent(question: string, districtId?: string): Promise<AgentResult>;
};

export type { AgentResult };
export type { AgentTrace } from '../../../src/ai/agent-core.ts';

export type { Driver, Exception, Incident, Principal, Territory };
