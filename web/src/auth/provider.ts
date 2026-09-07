/**
 * Which auth provider this build uses. One decision, made once, from config.
 *
 * Everything above this line imports `auth` and never learns which one it got.
 * That is what makes "point it at the user pool" a two-variable change in
 * `.env` rather than a search-and-replace through the UI:
 *
 *   VITE_COGNITO_DOMAIN and VITE_COGNITO_CLIENT_ID set  -> hosted UI, PKCE
 *   otherwise                                           -> the local issuer
 *
 * Offline, any address at a registered carrier domain signs in without a
 * password. Against a real pool the password is Cognito's, and the domain has
 * to exist in the membership table the token trigger reads.
 */
import type { AuthProvider } from './index.ts';
import { localAuth } from './local.ts';
import { cognitoAuth, cognitoConfigured } from './cognito.ts';

export const usingCognito = cognitoConfigured();

export const auth: AuthProvider = usingCognito ? cognitoAuth : localAuth;
