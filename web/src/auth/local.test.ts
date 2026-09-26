/**
 * The sign-in page's one-click accounts must all actually sign in.
 *
 * They are a hand-maintained list beside a hand-maintained membership table,
 * which is exactly the pair that drifted before (see the Terraform seed test
 * in platform/membership.test.ts). A button that fails with "no customer is
 * registered" is worse than no button.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_ACCOUNTS, localAuth } from './local.ts';
import { setClock, fixedClock } from '../../../src/platform/clock.ts';

setClock(fixedClock());

test('every demo account signs in, and each lands in a different scope', async () => {
  const seen = new Set<string>();
  for (const a of DEMO_ACCOUNTS) {
    const session = await localAuth.signIn(a.email);
    const p = session.principal;
    seen.add(p.tenantId + '|' + p.roles.join(',') + '|' + p.scope.kind);
  }
  assert.equal(seen.size, DEMO_ACCOUNTS.length, 'two accounts showing the same board is one too many');
});

test('the HHS account is on the list - the comms view needs it', () => {
  assert.ok(DEMO_ACCOUNTS.some((a) => a.email.endsWith('@hhs.texas.example')));
});
