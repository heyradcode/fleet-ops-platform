/**
 * ---------------------------------------------------------------------------
 * Sign in
 * ---------------------------------------------------------------------------
 * The interesting part of this screen is HOME-REALM DISCOVERY, and it is real.
 *
 * Type a work email and the platform decides which identity provider handles
 * it - SAML for one carrier, OIDC for another, the Cognito-native pool for
 * everyone else - before any password is asked for. That is what enterprise
 * users expect ("type your work email, land on your own login page"), Cognito
 * has no built-in support for it, and the lookup is the same one the hosted UI
 * would drive: `resolveIdpForEmail` in src/auth/providers.ts.
 *
 * Signing in is also what makes the board's scope real rather than asserted.
 * The district on the token comes from the PreTokenGeneration trigger, and a
 * Dallas dispatcher genuinely cannot reach Phoenix because their token does not
 * say they may.
 */
import { useMemo, useState } from 'react';
import { localAuth, DEMO_ACCOUNTS } from './auth/local.ts';
import { AuthError, type Realm, type Session } from './auth/index.ts';

type Props = { onSignedIn(session: Session): void };

export function SignIn({ onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'in' | 'up'>('in');

  // Discovery runs as you type. It costs nothing, and watching the provider
  // resolve is the clearest way to show what the lookup does.
  const realm: Realm | null = useMemo(
    () => (email.includes('@') && email.split('@')[1] ? localAuth.discover(email) : null),
    [email],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await localAuth.signIn(email.trim()));
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Sign-in failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function useAccount(address: string) {
    setEmail(address);
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await localAuth.signIn(address));
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Sign-in failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-panel">
        <header className="gate-brand">
          <span className="brand-mark">MERIDIAN</span>
          <span className="brand-rule" />
          <span className="gate-tag">Fleet dispatch</span>
        </header>

        {mode === 'in' ? (
          <>
            <form className="gate-form" onSubmit={submit}>
              <label className="field">
                <span className="field-label">Work email</span>
                <input
                  className="field-input mono"
                  type="email"
                  autoComplete="username"
                  placeholder="you@carrier.com"
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

              <button className="ask gate-submit" type="submit" disabled={busy || !realm}>
                {busy ? 'Signing in…' : realm ? realm.label : 'Continue'}
              </button>
            </form>

            <section className="gate-demo">
              <h2 className="panel-h">Or sign in as</h2>
              <p className="gate-note">
                Four accounts, each showing a different scope. There are no
                passwords — this build runs Cognito's logic against a local
                issuer rather than a user pool.
              </p>
              {DEMO_ACCOUNTS.map((a) => (
                <button
                  key={a.email}
                  className="demo-account"
                  onClick={() => useAccount(a.email)}
                  disabled={busy}
                >
                  <span className="demo-name">{a.name}</span>
                  <span className="demo-email mono">{a.email}</span>
                  <span className="demo-shows">{a.shows}</span>
                </button>
              ))}
            </section>

            <p className="gate-switch">
              New carrier?{' '}
              <button className="linkish" onClick={() => { setMode('up'); setError(null); }}>
                Register
              </button>
            </p>
          </>
        ) : (
          <SignUp onBack={() => { setMode('in'); setError(null); }} />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Register a carrier — not "create an account".
 *
 * A dispatcher does not sign themselves up for a fleet platform. The carrier is
 * onboarded, its SSO is configured, and its people arrive through it. Modelling
 * that honestly is more useful than a generic signup form, and it is also the
 * only truthful thing this screen can do: nothing here can grant access to
 * anyone's fleet data.
 */
function SignUp({ onBack }: { onBack(): void }) {
  const [email, setEmail] = useState('');
  const [carrierName, setCarrierName] = useState('');
  const [fleetSize, setFleetSize] = useState('50-500');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { message } = await localAuth.signUp({ email: email.trim(), carrierName, fleetSize });
      setDone(message);
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Registration failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="gate-form">
        <h2 className="panel-h">Request received</h2>
        <p className="gate-note">{done}</p>
        <button className="ask gate-submit" onClick={onBack}>Back to sign in</button>
      </div>
    );
  }

  return (
    <form className="gate-form" onSubmit={submit}>
      <h2 className="panel-h">Register a carrier</h2>
      <p className="gate-note">
        Onboarding creates the tenant, seeds its districts, and points your
        domain at your identity provider. An operations lead confirms it.
      </p>

      <label className="field">
        <span className="field-label">Carrier name</span>
        <input
          className="field-input"
          value={carrierName}
          onChange={(e) => setCarrierName(e.target.value)}
          placeholder="Acme Freight"
          required
        />
      </label>

      <label className="field">
        <span className="field-label">Work email</span>
        <input
          className="field-input mono"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="ops@carrier.com"
          required
        />
      </label>

      <label className="field">
        <span className="field-label">Fleet size</span>
        <select
          className="field-input"
          value={fleetSize}
          onChange={(e) => setFleetSize(e.target.value)}
        >
          <option>Under 50</option>
          <option>50-500</option>
          <option>500-5,000</option>
          <option>Over 5,000</option>
        </select>
      </label>

      {error && <p className="gate-error">{error}</p>}

      <button className="ask gate-submit" type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Request onboarding'}
      </button>
      <button className="linkish gate-back" type="button" onClick={onBack}>
        Back to sign in
      </button>
    </form>
  );
}
