/**
 * ---------------------------------------------------------------------------
 * The audit trail: every tool call the MCP server ran, and for whom
 * ---------------------------------------------------------------------------
 * The reason to put the tools behind a server at all is that the server can
 * answer "what did the assistant look at, for whom, and when?" - a question
 * the in-process loop answers only in a trace that dies with the response.
 *
 * WHAT IS KEPT, and what is deliberately not:
 *   - who (`sub`), which tool, the outcome, how long it took, and when - in
 *     REAL time (`wallNow()`): an audit row stamped with the demo's pinned
 *     8 September would be a lie about when a person asked.
 *   - a HASH of the arguments, never the arguments. They can hold whatever
 *     the model lifted from the question - a caller's name, a phone number -
 *     and an audit trail is the last place to start a second copy of PII.
 *     The hash still answers "was it the same call?".
 *   - no result. The result is the tenant's own data, which is already in
 *     the table it came from.
 *
 * It ages out: `expiresAt` (epoch SECONDS - DynamoDB TTL ignores anything
 * else, silently) after AUDIT_RETENTION_DAYS. TTL deletes lazily, so reads
 * filter on it rather than trust that expired rows are gone.
 *
 * Recording is best effort and NEVER fails the tool call: the person asked a
 * question, and a throttled audit write is not a reason to refuse them. It is
 * logged, loudly, instead - a silent gap in an audit trail is the failure to
 * avoid, and a log line is at least a trace of it.
 */
import type { Principal } from '../platform/types.ts';
import { wallNow } from '../platform/clock.ts';
import { sha256, toHex } from '../platform/crypto.ts';
import { log } from '../platform/logger.ts';
import { keys, mainTable } from '../aws/dynamodb.ts';

export const AUDIT_RETENTION_DAYS = 90;

export type AuditOutcome = 'ok' | 'error' | 'refused';

export type AuditEntry = {
  at: string;
  sub: string;
  tool: string;
  argsHash: string;
  outcome: AuditOutcome;
  ms: number;
  /** How the call arrived - only 'mcp' today; the field is for the day a second route exists. */
  via: 'mcp';
};

/**
 * A random suffix so two calls in one millisecond do not overwrite each
 * other. From `getRandomValues`, NOT `uuid()`: the demo seeds uuid(), and a
 * warm server reseeds per request, so every first call of every request
 * would get the same id and the audit trail would keep one row per ms.
 */
function suffix(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return toHex(b);
}

/**
 * Canonical JSON: keys sorted at every level, so the same arguments in a
 * different order hash the same. A model does not promise key order.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashArgs(input: Record<string, unknown>): string {
  return sha256(canonical(input));
}

export async function recordToolCall(
  principal: Principal,
  call: { tool: string; input: Record<string, unknown>; outcome: AuditOutcome; ms: number },
): Promise<void> {
  const nowMs = wallNow();
  const at = new Date(nowMs).toISOString();
  const entry: AuditEntry = {
    at, sub: principal.sub, tool: call.tool, argsHash: hashArgs(call.input),
    outcome: call.outcome, ms: call.ms, via: 'mcp',
  };
  try {
    await mainTable.put({
      ...keys.audit(principal, at, suffix()),
      ...entry,
      expiresAt: Math.floor(nowMs / 1000) + AUDIT_RETENTION_DAYS * 86_400,
    });
  } catch (err) {
    log.error('audit: tool call NOT recorded', {
      tenant: principal.tenantId, sub: principal.sub, tool: call.tool,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The newest entries for the caller's TENANT, newest first. Admins only: the
 * trail names who asked what, which is not an operator's business about
 * their colleagues. Tenant from the principal, as everywhere - never a
 * parameter.
 */
export async function recentAudit(principal: Principal, limit = 50): Promise<AuditEntry[]> {
  if (!principal.roles.includes('admin')) throw new Error('the audit trail is for admins');
  const nowS = Math.floor(wallNow() / 1000);
  const rows = await mainTable.query({
    pk: keys.audit(principal, '', '').PK,
    scanIndexForward: false,
    limit,
  });
  return rows
    .filter((r) => typeof r.expiresAt !== 'number' || r.expiresAt > nowS)
    .map((r) => ({
      at: String(r.at), sub: String(r.sub), tool: String(r.tool), argsHash: String(r.argsHash),
      outcome: r.outcome as AuditOutcome, ms: Number(r.ms), via: 'mcp',
    }));
}
