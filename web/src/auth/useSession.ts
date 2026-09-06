/**
 * The session hook, in its own module.
 *
 * Not a style preference: React Fast Refresh can only hot-swap a file whose
 * exports are all components. Exporting a hook beside `<SignIn>` made every
 * edit to that file a full reload, which Vite says out loud
 * ("Could not Fast Refresh") and is easy to leave broken for weeks.
 */
import { useEffect, useState } from 'react';
import { localAuth } from './local.ts';
import type { Session } from './index.ts';

/** Restore a session on load, so a refresh does not sign you out. */
export function useRestoredSession(): [Session | null, (s: Session | null) => void] {
  const [session, setSession] = useState<Session | null>(null);

  // Re-verified on restore rather than trusted - see localAuth.restore().
  useEffect(() => { setSession(localAuth.restore()); }, []);

  return [session, setSession];
}
