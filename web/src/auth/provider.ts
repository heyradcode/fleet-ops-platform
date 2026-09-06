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
 * The local provider ships the demo accounts; the hosted one has no business
 * showing them, since it has no way to honour a click on one.
 */
import type { AuthProvider } from './index.ts';
import { localAuth } from './local.ts';
import { cognitoAuth, cognitoConfigured } from './cognito.ts';

export const usingCognito = cognitoConfigured();

export const auth: AuthProvider = usingCognito ? cognitoAuth : localAuth;
