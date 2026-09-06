# Real identity, on AWS

The one directory in `infra/` meant to be applied. It creates a Cognito user
pool and the PreTokenGeneration trigger that stamps tenant and district into
the token — so the board's scope stops being a demonstration and becomes a
fact about a signed credential.

Everything else keeps running in the browser tab. That is the architecture
working, not a shortcut: the transport boundary means identity can be real
while the rest stays in-process.

## What it costs

Cognito is free to 10,000 monthly active users, the trigger sits inside the
Lambda free tier at any volume this will see, and the log group is capped at
14 days. Call it **pennies a month**, and the budget alarm here fires at $2.50
so you find out early rather than accurately.

The expensive parts of the platform are deliberately absent — Aurora (~$87/mo
idle), Kinesis (~$29/mo), and anything needing a vector store (OpenSearch
Serverless floors at ~$700/mo). The reasoning is at the top of `main.tf`.

## Apply it

```bash
pnpm build:lambda          # esbuild the trigger into .build/
cd infra/terraform/auth
terraform init

terraform apply \
  -var 'app_urls=["https://your-app.vercel.app"]' \
  -var 'alert_email=you@example.com'
```

`app_urls` takes origins **without a trailing slash**; `/callback` is appended
and `http://localhost:5180` is added for you. Cognito matches redirect URIs
exactly — no wildcards, no trailing-slash tolerance — and a mismatch shows up
as `redirect_mismatch` at the hosted UI rather than as anything more helpful.

## Then

**1. Check the pool answers.** `terraform output hosted_ui_url`, open it. You
should get a Cognito login page. Nobody can sign in yet — there are no users.

**2. Make a user.** Self-signup is off by design: a dispatcher does not sign
themselves up for a carrier's fleet.

```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$(terraform output -raw user_pool_id)" \
  --username dispatcher@acme-freight.com \
  --user-attributes Name=email,Value=dispatcher@acme-freight.com Name=email_verified,Value=true
```

The email domain is what the trigger looks up, so it has to be one the
membership table in `src/auth/pre-token-generation.ts` knows:
`acme-freight.com`, `safety.acme-freight.com`, `meridian.io` or
`northstar-logistics.com`. Any other domain gets a token with no tenant, the
verifier rejects it, and the board correctly shows nothing.

**3. Point the board at it.** `terraform output vercel_env` prints three
variables. Set all three on Vercel and redeploy:

```
VITE_COGNITO_DOMAIN     the hosted UI host
VITE_COGNITO_CLIENT_ID  the app client
VITE_COGNITO_ISSUER     https://cognito-idp.<region>.amazonaws.com/<poolId>
```

With any of them missing the board keeps using the offline provider. That is
the intended default, not a failure — the demo accounts stay clickable.

**4. Optional: Google sign-in.** Create an OAuth client in Google Cloud with
the authorized redirect URI `https://<domain>/oauth2/idpresponse`, then:

```bash
terraform apply \
  -var 'app_urls=["https://your-app.vercel.app"]' \
  -var 'alert_email=you@example.com' \
  -var 'google_client_id=...' \
  -var "google_client_secret=$GOOGLE_SECRET"
```

The social providers are created only when credentials exist — an identity
provider with an empty client id is an apply-time error, not a disabled one.

## Tearing it down

```bash
terraform destroy -var 'app_urls=["https://your-app.vercel.app"]' -var 'alert_email=you@example.com'
```

Deletion protection is off outside `prod`, so this works. Remove the three
Vercel variables too, or the board will point at a pool that no longer exists —
the symptom is a JWKS fetch failing and every restore returning signed-out.

## Two things worth knowing

**The trigger must be V2_0.** V1 writes claims to the ID token only, and this
platform authorises on the access token. Wire it to V1 and users sign in
successfully, arrive with no tenant claim, and the verifier rejects them —
a failure that looks like broken verification rather than a mis-versioned
trigger. `main.tf` pins it and a test pins the shape it produces.

**The custom attributes are a one-way door.** Cognito custom attributes cannot
be renamed or removed once the pool exists, and there is a hard cap of 50.
Changing `custom:tenantId` later means a new pool and re-registering everyone.
