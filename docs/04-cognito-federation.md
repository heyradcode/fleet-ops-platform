# Cognito, federation and multi-tenancy

## The one-sentence value proposition

Five identity providers, **one issuer**. Your API trusts exactly one token
format no matter how the user signed in — Google, Facebook, Apple, a customer's
ADFS via SAML, or a customer's Okta via OIDC. Google's tokens never reach your
front-end and never reach your API.

---

## User pools vs identity pools

Two different things with similar names.

- **User pool** — a user directory and an OIDC provider. Issues JWTs. This is
  what you almost always mean.
- **Identity pool** (Cognito Federated Identities) — exchanges a token for
  temporary **AWS credentials**, so a browser can call S3 or DynamoDB directly.
  Only needed for direct-to-AWS access; this project doesn't use one.

---

## The login flow

Authorization code + PKCE. The implicit flow is deprecated and leaks tokens in
the URL fragment — never use it for a SPA.

```
1. SPA → GET https://<domain>/oauth2/authorize
           ?response_type=code
           &client_id=…
           &redirect_uri=…
           &identity_provider=Google        ← skips the IdP chooser
           &code_challenge=<S256(verifier)>
           &code_challenge_method=S256
           &state=<random>                  ← CSRF; verify it on the way back

2. Cognito → Google. User authenticates there.

3. Google → Cognito with an auth code. Cognito exchanges it for Google tokens,
   reads the claims, applies your ATTRIBUTE MAPPING.

4. Cognito fires the PreTokenGeneration trigger.   ← where tenancy is stamped

5. Cognito → your redirect_uri with ITS OWN code.

6. SPA → POST /oauth2/token with the code + code_verifier
        → { id_token, access_token, refresh_token }
```

**PKCE in one line:** the client generates a random `verifier`, sends
`SHA256(verifier)` up front, and reveals the `verifier` only when redeeming the
code — so an intercepted code is useless without it. It exists because a public
SPA cannot hold a client secret.

---

## ID token vs access token

| | ID token | Access token |
|---|---|---|
| Answers | *Who is this user?* | *What may they do?* |
| Carries | Claims and attributes (email, name) | Scopes, `cognito:groups` |
| For | Your application | Your API |

They are **not** interchangeable — only the ID token carries user attributes.
Always check `token_use` when verifying.

---

## Verifying a token: the seven checks

Use `aws-jwt-verify` in production. Know what it does:

1. **Signature** — RS256, against the JWKS at
   `https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/jwks.json`,
   picking the key whose `kid` matches the token header. **Cache the JWKS**;
   fetching per request adds latency and can get you throttled.
2. **`iss`** — must be *your* pool. Otherwise any Cognito pool on earth can mint
   tokens your API accepts.
3. **`aud`** (ID token) or **`client_id`** (access token) — your app client.
4. **`token_use`** — `access` or `id`, whichever this endpoint requires.
5. **`exp`** — not expired.
6. **`iat`/`nbf`** — not from the future, allowing a little clock skew.
7. **`alg`** — must be what *you* expect. Never trust the token's own `alg`
   header: accepting it is the classic JWT algorithm-confusion attack (`none`,
   or HS256 signed with the public key on an RS256 pool).

→ `src/auth/cognito-jwt-verifier.ts` implements all seven with comments.

---

## PreTokenGeneration: where a federated user gains a tenant

This is **the** trigger for multi-tenant SaaS.

A Google user has no tenant. Google knows nothing about your product. This
Lambda runs after authentication but before Cognito signs the tokens, and lets
you add or override claims:

```ts
event.response.claimsOverrideDetails = {
  claimsToAddOrOverride: { 'custom:tenantId': membership.tenantId },
  claimsToSuppress: ['given_name', 'family_name', 'phone_number'],
  groupOverrideDetails: { groupsToOverride: membership.roles },
};
```

Every downstream service then gets tenancy **from a signed token**, with no
extra database call on the hot path.

Rules for this handler:

- It is on the critical path of **every login**. Keep it under ~100ms and give
  it provisioned concurrency if p99 matters.
- Throwing blocks the login entirely. Fail *open* to a viewer role for transient
  errors; fail *closed* — no tenant at all — for genuine authorisation failures.
- Claims aren't free. Tokens travel in an `Authorization` header and headers
  have size limits. Put **ids** in the token, not objects.

**Other triggers worth naming:** `PreSignUp` (auto-confirm, or link a federated
user to an existing native account), `PostConfirmation` (create the tenant row),
`PreAuthentication` (block a suspended tenant), `CustomMessage` (brand the
emails), `DefineAuthChallenge` (custom MFA / passwordless).

→ `src/auth/pre-token-generation.ts`

---

## Per-provider gotchas

These are the details that separate "I've read the docs" from "I've shipped it".

**Google** — map `username` to `sub`, never to email. People change email
addresses, and a username collision merges two humans into one account.

**Facebook** — can return a user with **no email** (phone-number signups). Make
email optional in the pool schema or federation fails at the last step.

**Sign in with Apple** — three traps:
- The name is sent **only on the very first authorisation**. Persist it then;
  you will never see it again.
- Private Relay gives you a `@privaterelay.appleid.com` address.
- The "client secret" is a **JWT you sign with a `.p8` key** and it **expires**
  (6 months max). Automate the rotation or logins break on a schedule.

**SAML 2.0** — claim names are URIs
(`http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`); copy
them verbatim from the IdP metadata. Use the **MetadataURL**, not a pasted
certificate, so Cognito picks up rotation automatically — a hard-coded cert
expires at 2am on a Sunday.

**OIDC** — far less painful than SAML: JSON not XML, discovery via
`/.well-known/openid-configuration`. Prefer it whenever the customer offers
both. Request the `groups` scope explicitly; Okta omits it otherwise.

---

## Home-realm discovery

Enterprises expect: type your work email, land on **your own** login page.
Cognito has no built-in support, so you build the lookup (DynamoDB in
production) and pass the result as `identity_provider` on `/authorize`.

```
alice@acme.com   → AcmeSAML
bob@globex.com   → OktaOIDC
carol@gmail.com  → COGNITO      (native, or the social chooser)
```

→ `resolveIdpForEmail` in `src/auth/providers.ts`

---

## App client hardening

The settings that matter, and why:

| Setting | Value | Why |
|---|---|---|
| `generate_secret` | `false` | A secret in a browser bundle is not a secret |
| `allowed_oauth_flows` | `["code"]` | Never `implicit` |
| `access_token_validity` | 1 hour | A leaked token is useful for at most an hour |
| `refresh_token_validity` | 30 days | With `enable_token_revocation = true` |
| `prevent_user_existence_errors` | `ENABLED` | Don't leak which emails have accounts |
| `explicit_auth_flows` | `SRP` + `REFRESH_TOKEN` | SRP never puts the password on the wire |
| `write_attributes` | **excludes** `custom:tenantId` | Or a user can move themselves into another tenant |

That last row is the one people miss.

**Custom attributes** cannot be renamed or deleted once created, and there is a
hard cap of 50 per pool. A one-way door — think before adding one.

→ `infra/terraform/modules/cognito/main.tf`

---

## From token to tenant isolation

```
Cognito token
   custom:tenantId = "acme"
   cognito:groups  = ["operator"]
        │
        ▼  verified by AppSync / the Lambda authorizer
   Principal { tenantId: 'acme', roles: ['operator'] }
        │
        ▼  every repository function takes a Principal
   PK = "TENANT#acme#SIGNAL"
        │
        ▼  and IAM independently enforces the same boundary
   Condition: dynamodb:LeadingKeys = ["TENANT#acme#*"]
```

The point of the middle step is that there is no function taking a bare
`tenantId` string, so there is no code path that *can* forget it. The point of
the last step is that even a buggy Lambda is refused by AWS itself.

→ `src/platform/tenancy.ts`, and `src/platform/tenancy.test.ts` for the tests
that would be a breach if they ever failed.
