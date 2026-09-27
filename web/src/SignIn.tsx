/**
 * ---------------------------------------------------------------------------
 * Sign in - through the real Cognito pool, and only through it
 * ---------------------------------------------------------------------------
 * Type a work email and the platform decides which identity provider handles
 * it - HOME-REALM DISCOVERY, `resolveIdpForEmail` in src/auth/providers.ts,
 * bounded to the providers the pool actually has - then Continue goes to the
 * hosted UI with PKCE. The password is Cognito's; this page never sees one.
 *
 * What the account can see is decided AFTER Cognito authenticates it: the
 * PreTokenGeneration trigger looks the email's domain up in the membership
 * table and stamps tenant, role and site into the access token. An account
 * whose domain is not there signs in successfully and is then refused here,
 * with a sentence saying so - the fail-closed path, not a broken sign-in.
 *
 * No self-registration. Accounts are created by an administrator
 * (`aws cognito-idp admin-create-user`, see infra/terraform/auth/README.md):
 * an estate platform onboards organisations, it does not let strangers sign
 * themselves up next to real customers. The offline issuer and its one-click
 * accounts are gone from this page; they survive only as test fixtures.
 */
import { useEffect, useMemo, useState } from 'react';
import { auth } from './auth/provider.ts';
import { AuthError, type Realm, type Session } from './auth/index.ts';

type Props = {
  onSignedIn(session: Session): void;
  /** Why the page arrived signed out - a failed redirect, an expired token. */
  initialError?: string | null;
};

export function SignIn({ onSignedIn, initialError = null }: Props) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  // useState's initial value is used on the FIRST render and never again, so
  // an error that arrives later - and this one always does, because the token
  // exchange is async - would set the prop and change nothing on screen. That
  // is what "the callback page is just the sign-in page again" was: a failed
  // redirect whose reason was computed, passed down, and silently dropped.
  useEffect(() => {
    if (initialError) setError(initialError);
  }, [initialError]);

  // Discovery runs as you type. It costs nothing, and watching the provider
  // resolve is the clearest way to show what the lookup does.
  const realm: Realm | null = useMemo(
    () => (email.includes('@') && email.split('@')[1] ? auth.discover(email) : null),
    [email],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Navigates to the hosted UI; the session arrives on the way back, in
      // useRestoredSession. onSignedIn is here for the interface's sake.
      onSignedIn(await auth.signIn(email.trim()));
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Sign-in failed. Try again.');
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-panel">
        <header className="gate-brand">
          <span className="brand-mark">NETPULSE</span>
          <span className="brand-rule" />
          <span className="gate-tag">Operations board</span>
        </header>

        <form className="gate-form" onSubmit={submit}>
          <label className="field">
            <span className="field-label">Work email</span>
            <input
              className="field-input mono"
              type="email"
              autoComplete="username"
              placeholder="you@customer.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </label>

          {/* The discovery result, as it resolves. */}
          {realm && (
            <p className={`realm is-${realm.kind}`}>
              <span className="realm-kind">{realm.kind}</span>
              {realm.kind === 'cognito'
                ? 'No single sign-on for this domain — the Cognito pool will handle it.'
                : `Routed to ${realm.idp}. You will sign in with your own provider.`}
            </p>
          )}

          {error && <p className="gate-error">{error}</p>}

          {/* Cognito keeps its OWN session cookie, so /oauth2/authorize
              re-issues a code for the same rejected account on every
              attempt - a loop with no visible exit. Only /logout breaks
              it, and that is what signOut() does. */}
          {error && (
            <button type="button" className="linkish gate-switch" onClick={() => auth.signOut()}>
              Sign in as someone else
            </button>
          )}

          <button className="ask gate-submit" type="submit" disabled={busy || !realm}>
            {busy ? 'Signing in…' : realm ? realm.label : 'Continue'}
          </button>
        </form>

        <p className="gate-note">
          No account? Ask your operations lead - accounts are created for you,
          and your organisation has to be registered before you can see anything.
        </p>
      </div>
    </div>
  );
}

/**
 * Shown instead of sign-in when the build has no pool to sign in to.
 *
 * Better than the alternative it replaced - a silent fallback to an offline
 * issuer - because a board that signs people in some other way when the pool
 * is misconfigured is a board whose sign-in nobody can reason about.
 */
export function CognitoNotConfigured() {
  return (
    <div className="gate">
      <div className="gate-panel">
        <header className="gate-brand">
          <span className="brand-mark">NETPULSE</span>
          <span className="brand-rule" />
          <span className="gate-tag">Operations board</span>
        </header>
        <div className="gate-form">
          <h2 className="panel-h">Sign-in is not configured</h2>
          <p className="gate-note">
            This build has no Cognito user pool to sign in to. Put these in{' '}
            <code className="mono">web/.env.cognito.local</code> and restart{' '}
            <code className="mono">pnpm web</code>:
          </p>
          <pre className="mono gate-note">
            VITE_COGNITO_DOMAIN{'\n'}VITE_COGNITO_CLIENT_ID{'\n'}VITE_COGNITO_ISSUER{'\n'}VITE_BOARD_API_URL  (optional)
          </pre>
          <p className="gate-note">
            <code className="mono">terraform output vercel_env</code> in{' '}
            <code className="mono">infra/terraform/auth</code> prints the values.
          </p>
        </div>
      </div>
    </div>
  );
}
