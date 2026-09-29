/**
 * The pre-flight before the hosted UI: a build pointing at a deleted pool
 * says so, instead of sending the person to a hostname that is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertPoolExists } from './cognito.ts';
import { AuthError } from './index.ts';

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE';
const answer = (status: number, body: string): typeof fetch => async () => new Response(body, { status });
const quiet = <T>(run: () => Promise<T>) => {
  const warn = console.warn;
  console.warn = () => {};
  return run().finally(() => { console.warn = warn; });
};

test('a pool that exists: nothing to say, the redirect goes ahead', async () => {
  await assertPoolExists(ISSUER, answer(200, '{"keys":[]}'));
});

test('a DELETED pool - Cognito\'s own answer - stops the redirect with a sentence, not a dead hostname', async () => {
  const deleted = answer(400, '{"message":"User pool us-east-1_EXAMPLE does not exist."}');
  await quiet(() => assert.rejects(assertPoolExists(ISSUER, deleted), (err: unknown) =>
    err instanceof AuthError && /sign-in service that no longer exists/.test(err.message)));
});

test('no answer at all is said as that; any OTHER hiccup lets the redirect try', async () => {
  const offline: typeof fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(assertPoolExists(ISSUER, offline), /cannot be reached/);
  // A throttle or a 500 is not proof the pool is gone: locking people out on it would be worse than the bug.
  await assertPoolExists(ISSUER, answer(500, 'Internal error'));
  await assertPoolExists(ISSUER, answer(429, 'Too many requests'));
});
