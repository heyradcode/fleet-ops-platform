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

## Before you start

Two CLIs, neither of which ships with the repo:

```powershell
winget install Hashicorp.Terraform
winget install Amazon.AWSCLI
```

Then credentials. `aws configure sso` is the right answer if you have IAM
Identity Center; an IAM user's access keys via `aws configure` is the pragmatic
one for a personal account. Confirm it works before touching Terraform, because
"no valid credential sources" is otherwise the first thing the apply tells you:

```bash
aws sts get-caller-identity
```

### What the identity must be allowed to do

Cognito pools, Lambda functions, IAM roles, log groups and budgets. A typical
developer group covers Lambda, IAM and CloudWatch but **not** the two that are
unusual, and the apply gets far enough to create the Lambda before failing on
them - a half-built stack and two `AccessDeniedException`s:

```bash
cd infra/terraform/auth   # deploy-policy.json is referenced relatively

# Cognito. Grants cognito-idp:*, so it covers destroy as well as apply.
aws iam attach-user-policy --user-name YOUR_USER --policy-arn arn:aws:iam::aws:policy/AmazonCognitoPowerUser

# Budgets is account-scoped and no managed policy grants creating one.
aws iam put-user-policy --user-name YOUR_USER --policy-name MeridianBudgets --policy-document file://deploy-policy.json
```

`deploy-policy.json` sits beside this file; change the account id in it if you
are deploying elsewhere. Attach both to the **user**, not to a shared group -
nobody else needs Cognito because of this.

To undo afterwards: `detach-user-policy` and `delete-user-policy` with the same
names.

On a personal account `AdministratorAccess` instead of both is the pragmatic
choice. On anything shared it should stay scoped, because an identity that can
create IAM roles can create one more privileged than itself.

## Apply it

```bash
pnpm build:lambda          # esbuild the trigger into .build/
cd infra/terraform/auth
terraform init

terraform plan \
  -var 'app_urls=["https://your-app.vercel.app"]' \
  -var 'alert_email=you@example.com'
```

**Read the plan.** It should create around fifteen resources and no database.
If it mentions `aws_rds_cluster` you are in the wrong directory. Then swap
`plan` for `apply`.

If it fails saying the domain already exists, that is the one name here that is
globally unique across every AWS account, and a stranger has it. Add
`-var 'domain_prefix=meridian-<something-of-yours>'`.

`app_urls` takes origins **without a trailing slash**; `/callback` is appended
and `http://localhost:5180` is added for you. Cognito matches redirect URIs
exactly — no wildcards, no trailing-slash tolerance — and a mismatch shows up
as `redirect_mismatch` at the hosted UI rather than as anything more helpful.

## Then

**1. Check the pool answers.** `terraform output hosted_ui_url`, open it. You
should get a Cognito login page. Nobody can sign in yet — there are no users.

**2. Make a user.** Self-signup is off (`admin_create_user_config`): a dispatcher does not sign
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
the intended default, not a failure — the local issuer still mints and
verifies tokens for the registered carrier domains, with no password.

### Onboarding a carrier

Membership lives in the DynamoDB table this root creates, not in code. Adding
a carrier is a row:

```bash
aws dynamodb put-item --table-name meridian-demo-membership --item '{
  "PK":       {"S": "TENANT_MEMBERSHIP#newco.example"},
  "tenantId": {"S": "newco"},
  "roles":    {"SS": ["dispatcher"]},
  "district": {"S": "phx"}
}'
```

No rebuild, no deploy. Terraform seeds the four demo carriers with
`aws_dynamodb_table_item`, which manages only the rows it declares — rows
added this way survive the next `apply` rather than being destroyed.

Omit `district` for tenant-wide scope. `roles` is a string SET, and only
`admin`, `safety`, `dispatcher`, `driver` and `viewer` map to anything —
anything else degrades to `viewer` rather than failing.

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
