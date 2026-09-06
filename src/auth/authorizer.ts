/**
 * ---------------------------------------------------------------------------
 * API Gateway Lambda authorizer (REQUEST type, IAM-policy response)
 * ---------------------------------------------------------------------------
 * You have three ways to protect an API Gateway route. Know when to use each:
 *
 *   1. COGNITO USER POOL AUTHORIZER - zero code. API Gateway validates the JWT
 *      itself. Use it when "valid token" is the whole authorisation rule.
 *   2. LAMBDA AUTHORIZER (this file) - your code returns an IAM policy. Use it
 *      when the decision needs your data: tenant status, per-route roles,
 *      IP allow-lists, subscription tier.
 *   3. IAM AUTH - SigV4. For service-to-service, not for humans.
 *
 * The two things that make a Lambda authorizer viable in production:
 *
 *   CACHING. Set `authorizerResultTtlInSeconds` (up to 3600) and make sure the
 *   `identitySource` is the Authorization header. API Gateway then caches the
 *   POLICY per token, so a busy user costs you one authorizer invocation, not
 *   one per request. Beware the trap: the cached policy is keyed on the token,
 *   NOT the path - so if you return a resource-specific policy with caching on,
 *   the first path the user hits is the only one they can reach. Return a
 *   wildcard policy over the API and enforce per-route rules in `context`.
 *
 *   CONTEXT. Whatever you return in `context` is passed to the integration as
 *   `event.requestContext.authorizer`. That is how tenantId and roles reach the
 *   handler WITHOUT it re-parsing the JWT. Values must be strings/numbers/
 *   booleans - no objects, no arrays. Join arrays yourself.
 */
import { verifyToken } from './cognito-jwt-verifier.ts';
import type { Principal } from '../platform/types.ts';
import { log } from '../platform/logger.ts';

export type AuthorizerEvent = {
  type: 'REQUEST';
  methodArn: string;
  headers: Record<string, string>;
};

export type AuthorizerResult = {
  principalId: string;
  policyDocument: {
    Version: '2012-10-17';
    Statement: Array<{ Action: string; Effect: 'Allow' | 'Deny'; Resource: string }>;
  };
  context: Record<string, string | number | boolean>;
};

export async function handler(event: AuthorizerEvent): Promise<AuthorizerResult> {
  const header = event.headers.authorization ?? event.headers.Authorization ?? '';
  const token = header.replace(/^Bearer\s+/i, '');

  try {
    const principal = verifyToken(token);
    log.debug('authorizer allow', { sub: principal.sub, tenantId: principal.tenantId });
    return allow(principal, event.methodArn);
  } catch (err) {
    log.warn('authorizer deny', { error: err instanceof Error ? err.message : String(err) });
    // Returning an explicit Deny gives the caller a 403.
    // Throwing the literal string 'Unauthorized' gives a 401 instead - use that
    // when the token is missing or expired so clients know to refresh.
    return deny(event.methodArn);
  }
}

function allow(principal: Principal, methodArn: string): AuthorizerResult {
  return {
    principalId: principal.sub,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: wildcardArn(methodArn) }],
    },
    context: {
      tenantId: principal.tenantId,
      email: principal.email,
      roles: principal.roles.join(','),     // arrays are not allowed in context
      identityProvider: principal.identityProvider,
    },
  };
}

function deny(methodArn: string): AuthorizerResult {
  return {
    principalId: 'anonymous',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: 'Deny', Resource: methodArn }],
    },
    context: {},
  };
}

/**
 * Turn arn:...:api-id/stage/GET/signals into arn:...:api-id/stage/-STAR-/-STAR-
 * so one cached policy covers every route. Per-route authorisation then happens
 * in the handler, using the roles we passed through `context`.
 */
function wildcardArn(methodArn: string): string {
  const [arn, partition, , region, account, rest] = methodArn.split(':');
  const [apiId, stage] = (rest ?? '').split('/');
  return [arn, partition, 'execute-api', region, account, apiId + '/' + stage + '/*/*'].join(':');
}

/** Rebuild the Principal on the handler side from the authorizer context. */
export function principalFromContext(ctx: Record<string, string>): Principal {
  return {
    sub: ctx.principalId ?? ctx.sub ?? 'unknown',
    email: ctx.email ?? '',
    tenantId: ctx.tenantId,
    roles: (ctx.roles ?? 'viewer').split(',') as Principal['roles'],
    identityProvider: (ctx.identityProvider ?? 'cognito') as Principal['identityProvider'],
  };
}
