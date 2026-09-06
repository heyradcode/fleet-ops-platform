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
import { localAuth } from './local.ts';
import { inProcessTransport } from '../transport/in-process.ts';
import type { Session } from './index.ts';

export function useRestoredSession(): [Session | null, (s: Session | null) => void] {
  const [session, setState] = useState<Session | null>(null);

  // Transport first, React second. Never the other way round - see above.
  const setSession = useCallback((s: Session | null) => {
    inProcessTransport.setSession(s?.principal ?? null);
    setState(s);
  }, []);

  // Restore on load, so a refresh does not sign you out. Re-verified rather
  // than trusted - see localAuth.restore().
  useEffect(() => { setSession(localAuth.restore()); }, [setSession]);

  return [session, setSession];
}
