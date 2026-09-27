/**
 * Which auth provider this build uses. One decision, made once, from config.
 *
 * Everything above this line imports `auth` and never learns which one it got.
 * That is what makes "point it at the user pool" a three-variable change in
 * an env file rather than a search-and-replace through the UI:
 *
 *   VITE_COGNITO_DOMAIN, _CLIENT_ID and _ISSUER all set -> hosted UI, PKCE
 *   any of them missing                                 -> the local issuer
 *
 * Locally they live in `web/.env.cognito.local`, which Vite reads only in
 * `--mode cognito` (`pnpm web:cognito`). The NAME matters: Vite loads `.env`,
 * `.env.local`, `.env.[mode]` and `.env.[mode].local` and nothing else, so a
 * file called `.env.local.cognito` is silently ignored and the board quietly
 * stays on the offline issuer - which looks like Cognito being broken.
 *
 * Offline, any address at a registered customer domain signs in without a
 * password. Against a real pool the password is Cognito's, and the domain has
 * to exist in the membership table the token trigger reads.
 */
import type { AuthProvider } from './index.ts';
import { localAuth } from './local.ts';
import { cognitoAuth, cognitoConfigured } from './cognito.ts';

export const usingCognito = cognitoConfigured();

export const auth: AuthProvider = usingCognito ? cognitoAuth : localAuth;
