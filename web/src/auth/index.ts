/**
 * ---------------------------------------------------------------------------
 * The authentication boundary
 * ---------------------------------------------------------------------------
 * Same shape as the transport boundary next door, for the same reason: the UI
 * depends on this interface, and there are two implementations behind it.
 *
 *   local     runs the real Cognito LOGIC offline - home-realm discovery, the
 *             PreTokenGeneration trigger, token minting and the verifier's
 *             seven checks - with a local issuer instead of a user pool.
 *   cognito   the actual hosted UI: authorization code + PKCE, redirect,
 *             token exchange. Present, and unused until a pool exists.
 *
 * WHY THIS EARNS ITS PLACE rather than being a fake login form:
 *
 * The board's district scope used to be hardcoded. Signing in makes it come
 * from a token that was actually minted and actually verified, so "a Dallas
 * dispatcher cannot see Phoenix" becomes something you do by logging in as one
 * rather than something the code claims. The seven verification checks, the
 * signed district claim and the fail-closed unknown domain are all real and all
 * exercised.
 *
 * What is NOT real offline: the signature is HMAC with a demo secret rather
 * than RS256 against a pool's JWKS, and there is no password store. Those are
 * the two things a user pool exists to provide, and neither changes the shape
 * of anything above this line.
 */
import type { Principal } from '../../../src/platform/types.ts';

export type Session = {
  /** The access token. Sent as the Authorization header by a real client. */
  token: string;
  /** What the verifier made of it. Never trusted from anywhere else. */
  principal: Principal;
};

/** What home-realm discovery decided about an email address. */
export type Realm = {
  /** The IdP Cognito would hand this user to. */
  idp: string;
  kind: 'saml' | 'oidc' | 'cognito';
  /** Shown to the user: "Continue with your Acme Freight account". */
  label: string;
};

export type SignUpRequest = {
  email: string;
  carrierName: string;
  fleetSize: string;
};

export type AuthProvider = {
  /**
   * The session restored from storage, if any.
   *
   * A promise because verifying a REAL pool's token is RS256 against its
   * published JWKS, and WebCrypto is async. The offline provider resolves
   * immediately; the interface does not pretend the two are the same shape.
   */
  restore(): Promise<Session | null>;

  /**
   * Which identity provider handles this email.
   *
   * Enterprises expect "type your work email, land on your own login page".
   * Cognito has no built-in support for that, so the lookup is ours - see
   * `resolveIdpForEmail` in src/auth/providers.ts.
   */
  discover(email: string): Realm;

  /** Complete a sign-in. Throws with a message fit to show the user. */
  signIn(email: string): Promise<Session>;

  /** Social sign-in, by provider name. */
  signInWith(provider: string, email: string): Promise<Session>;

  /**
   * Register a carrier.
   *
   * Not self-serve access: see the note in local.ts on why a fleet platform
   * onboards organisations rather than individuals.
   */
  signUp(request: SignUpRequest): Promise<{ message: string }>;

  signOut(): void;
};

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}
