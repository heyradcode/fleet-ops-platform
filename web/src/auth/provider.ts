/**
 * The auth provider: the real Cognito pool, and nothing else.
 *
 * The board signs in through the hosted UI with PKCE and authorises on the
 * pool's ACCESS token - see cognito.ts. There is no offline fallback on the
 * sign-in page: a build without the pool's settings shows how to supply them
 * (App.tsx) rather than quietly signing people in some other way.
 *
 * The settings are three variables, all required:
 *
 *   VITE_COGNITO_DOMAIN, VITE_COGNITO_CLIENT_ID, VITE_COGNITO_ISSUER
 *   (VITE_COGNITO_IDPS optional, defaults to COGNITO)
 *
 * Locally they live in `web/.env.cognito.local`, which `pnpm web` loads (Vite
 * `--mode cognito`). The NAME matters: Vite reads `.env`, `.env.local`,
 * `.env.[mode]` and `.env.[mode].local` and nothing else, so a file called
 * `.env.local.cognito` is silently ignored. `terraform output vercel_env`
 * prints the values.
 *
 * The offline issuer (local.ts) is kept for the tests only.
 */
import type { AuthProvider } from './index.ts';
import { cognitoAuth, cognitoConfigured } from './cognito.ts';

/** False when the build is missing the pool's settings - App shows how to fix it. */
export const cognitoReady = cognitoConfigured();

export const auth: AuthProvider = cognitoAuth;
