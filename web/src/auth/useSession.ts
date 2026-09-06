/**
 * The session hook, in its own module.
 *
 * Two things live here, and both are about ORDER.
 *
 * 1. React Fast Refresh can only hot-swap a file whose exports are all
 *    components. Exporting a hook beside `<SignIn>` made every edit to that
 *    file a full reload, which Vite says out loud ("Could not Fast Refresh")
 *    and is easy to leave broken for weeks.
 *
 * 2. React runs effects CHILD-FIRST. Installing the session on the transport
 *    from an effect in `<App>` meant `<Board>`'s own load effect ran before it
 *    - and the transport, correctly, refused: "No session". The first board
 *    after every sign-in failed, and the tests never saw it because they call
 *    setSession themselves before loading. So the transport is told about the
 *    session HERE, synchronously, in the same call that updates React state.
 *    By the time anything renders with a session, the transport already has it.
 */
import { useCallback, useEffect, useState } from 'react';
import { auth, usingCognito } from './provider.ts';
import { completeRedirect } from './cognito.ts';
import { inProcessTransport } from '../transport/in-process.ts';
import type { Session } from './index.ts';

type Restored = [
  session: Session | null,
  setSession: (s: Session | null) => void,
  /** Why the page arrived signed out, when there is a reason worth showing. */
  restoreError: string | null,
];

export function useRestoredSession(): Restored {
  const [session, setState] = useState<Session | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Transport first, React second. Never the other way round - see above.
  const setSession = useCallback((s: Session | null) => {
    inProcessTransport.setSession(s?.principal ?? null);
    setState(s);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(globalThis.location?.search ?? '');

    // Back from the hosted UI. The code in the URL is single-use and must not
    // survive a refresh, so it is exchanged and then scrubbed from history.
    if (usingCognito && (params.has('code') || params.has('error'))) {
      completeRedirect(params)
        .then((s) => {
          globalThis.history.replaceState(null, '', globalThis.location.pathname);
          setSession(s);
        })
        .catch((err: unknown) => {
          setRestoreError(err instanceof Error ? err.message : 'Sign-in failed. Try again.');
        });
      return;
    }

    // Restore on load, so a refresh does not sign you out. Re-verified rather
    // than trusted - see localAuth.restore().
    let stale = false;
    auth.restore()
      .then((s) => { if (!stale) setSession(s); })
      .catch(() => { if (!stale) setSession(null); });
    return () => { stale = true; };
  }, [setSession]);

  return [session, setSession, restoreError];
}
