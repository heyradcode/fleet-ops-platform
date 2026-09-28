# Real identity, on AWS

The one directory in `infra/` meant to be applied. It creates a Cognito user
pool and the PreTokenGeneration trigger that stamps tenant and site into
the token — so the board's scope stops being a demonstration and becomes a
fact about a signed credential — and the platform's DynamoDB table, which
`pnpm seed:aws` fills from the same code the offline board runs.

It also creates the board API - an HTTP API and one read-only Lambda
serving `GET /board`, `GET /comms` and `GET /audit` (the MCP server's audit
trail, admins only) from that table. With `VITE_BOARD_API_URL` set the board
reads those views from it; without, it computes them in the tab, which is
the offline default. Either way the
answer is the same, because both call the same functions
(`src/api/board-api.ts`).

## What it costs

Cognito is free to 10,000 monthly active users, the trigger sits inside the
Lambda free tier at any volume this will see, and the log group is capped at
14 days. The main table is on-demand: a full `pnpm seed:aws` is about 700
writes and 600 reads, a tenth of a cent, and storage is inside the 25 GB free
tier. Call it **pennies a month**, and the budget alarm here fires at $2.50
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

# Budgets, the two tables and the board API. A CUSTOMER-MANAGED policy, not
# an inline one: a user's inline policies share 2,048 characters IN TOTAL, and
# with anything else already inline this one fails with LimitExceeded.
# Managed policies hold 6,144 each and do not count toward that.
aws iam create-policy --policy-name NetpulseDeploy --policy-document file://deploy-policy.json
aws iam attach-user-policy --user-name YOUR_USER --policy-arn arn:aws:iam::ACCOUNT_ID:policy/NetpulseDeploy
```

`deploy-policy.json` also grants the two DynamoDB tables and the board API's
HTTP API (`apigateway:*` verbs on `/apis`), which a developer group usually
lacks. After pulling a newer copy, publish it as a new version of the same
policy - `create-policy` refuses a name that exists:

```bash
aws iam create-policy-version --policy-arn arn:aws:iam::ACCOUNT_ID:policy/NetpulseDeploy --policy-document file://deploy-policy.json --set-as-default
```

An identity set up by an older copy of this README has the same permissions
as an INLINE policy called `NetpulseBudgets`; once `NetpulseDeploy` is
attached it is redundant (`aws iam delete-user-policy`). `seed-policy.json`
goes on the same way, as `NetpulseSeed`.

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
`-var 'domain_prefix=netpulse-<something-of-yours>'`.

`app_urls` takes origins **without a trailing slash**; `/callback` is appended
and `http://localhost:5180` is added for you. Cognito matches redirect URIs
exactly — no wildcards, no trailing-slash tolerance — and a mismatch shows up
as `redirect_mismatch` at the hosted UI rather than as anything more helpful.

## Then

**1. Check the pool answers.** `terraform output hosted_ui_url`, open it. You
should get a Cognito login page. Nobody can sign in yet — there are no users.

**2. Make a user.** Self-signup is off (`admin_create_user_config`): an operator does not sign
themselves up for a customer's estate.

```bash
aws cognito-idp admin-create-user \
  --user-pool-id "$(terraform output -raw user_pool_id)" \
  --username operator@acme-networks.com \
  --user-attributes Name=email,Value=operator@acme-networks.com Name=email_verified,Value=true
```

The email domain is what the trigger looks up, and **a fresh apply leaves the
membership table empty** - `seed_demo_customers` is off by default, because a
real pool should hold your customers rather than four fictional ones. So create
the user, then add its domain as a row (next section). Until you do, that user
signs in, gets a token with no tenant, the verifier rejects it, and the board
correctly shows nothing. That is the fail-closed path, not a broken deploy.

Set `seed_demo_customers = true` if you want `acme-networks.com` and friends
written for a walkthrough. It changes nothing locally either way: the offline
board and the tests read `DEMO_MEMBERSHIPS` in `src/platform/membership.ts`
and never touch this table.

**3. Point the board at it.** `terraform output vercel_env` prints three
variables. Set all three on Vercel and redeploy:

```
VITE_COGNITO_DOMAIN     the hosted UI host
VITE_COGNITO_CLIENT_ID  the app client
VITE_COGNITO_ISSUER     https://cognito-idp.<region>.amazonaws.com/<poolId>
```

All three are required. The board signs in through the pool and nothing
else: with any of them missing it shows a "sign-in is not configured" page
naming them, rather than signing people in some other way.

**Locally,** `pnpm web:env` writes them - with the API URL below - into
`web/.env.cognito.local`, and `pnpm web` loads that file (Vite's
`--mode cognito`). The pool already allows `http://localhost:5180/callback`,
which is why the dev port is pinned. The file NAME is load-bearing: Vite
reads `.env.[mode].local`, and a `.env.local.cognito` is silently ignored.

**Who can see what** is decided by the email's DOMAIN, through the membership
table, after Cognito has authenticated the person. Sign in with an address at
a domain that has no row and Cognito lets you in, the trigger finds no
customer, and the board refuses you with a sentence saying so - fail closed.
So each person needs two things: a user in the pool, and a membership row
for their domain (next section).

A user with a real mailbox gets Cognito's invitation email with a temporary
password and is asked to set their own at first sign-in:

```bash
aws cognito-idp admin-create-user --user-pool-id "<user_pool_id>" --username you@yourdomain.com --user-attributes Name=email,Value=you@yourdomain.com Name=email_verified,Value=true
```

`.example` domains (`hhs.texas.example`) can receive no mail, so for those,
suppress the invitation and set the password yourself:

```bash
aws cognito-idp admin-create-user --user-pool-id "<user_pool_id>" --username ops-lead@hhs.texas.example --message-action SUPPRESS --user-attributes Name=email,Value=ops-lead@hhs.texas.example Name=email_verified,Value=true
aws cognito-idp admin-set-user-password --user-pool-id "<user_pool_id>" --username ops-lead@hhs.texas.example --permanent --password "<choose one>"
```

`terraform output -raw user_pool_id` prints the pool id. The header shows
the user's `sub`, not an address: a Cognito ACCESS token has no `email`
claim, and the trigger deliberately adds none.

### Onboarding a customer

Membership lives in the DynamoDB table this root creates, not in code. Adding
a customer is a row:

```bash
aws dynamodb put-item --table-name netpulse-demo-membership --item '{
  "PK":       {"S": "TENANT_MEMBERSHIP#newco.example"},
  "tenantId": {"S": "newco"},
  "roles":    {"SS": ["operator"]},
  "site": {"S": "phx-01"}
}'
```

In Windows PowerShell, put the JSON in a file instead - PowerShell 5.1
strips the inner quotes when it hands a string to a native program, and the
CLI then reports a parse error about JSON that looks correct:

```powershell
aws dynamodb put-item --table-name netpulse-demo-membership --item file://membership.json
```

**The comms view** (Teams, Genesys, Webex, the SIP trunks) belongs to the
`hhs-demo` tenant and needs tenant-wide scope, so its row is
`"tenantId": {"S": "hhs-demo"}`, `"roles": {"SS": ["admin"]}` and no `site` -
for whichever domain the people who should see it sign in with.

No rebuild, no deploy. Terraform declares rows with `aws_dynamodb_table_item`,
which manages only the rows it declares — rows added this way survive the next
`apply` rather than being destroyed.

Omit `site` for tenant-wide scope, and use a real site id: they are
`dal-01`, `aus-01`, `den-01`, `chi-01` and `phx-01` (`src/data/estate.ts`).
A site id nothing matches is not an error — it is a scope that admits zero
devices, so the person signs in to an empty board with nothing to explain it.

`roles` is a string SET, and **only `admin`, `operator`, `engineer` and
`viewer` mean anything**. That list is `mapGroupsToRoles` in
`src/auth/cognito-jwt-verifier.ts`, and anything else is dropped — a row with
one unrecognised role degrades silently to `viewer`, which is how an engineer
ends up read-only with nothing saying why.

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

### Filling the main table

`main-table.tf` creates `netpulse-<env>-main`, empty. The platform's own data -
comms incidents, health, the workforce counts, baselines, device state - is
written by the same code the offline board runs, pointed at the table:

```bash
pnpm seed:aws --dry-run     # the whole run through an in-memory table: what it would write, no AWS
TABLE_NAME="$(terraform -chdir=infra/terraform/auth output -raw main_table_name)" pnpm seed:aws
```

The vendors are still the mocks - real storage does not make a Teams tenant
real - so what lands is the demo's synthetic data. The credentials running it
need `seed-policy.json` on the table (the deploy identity does not have Query
or BatchWriteItem; it only ever needed to create tables).

Run it again and it is one more poll, as a scheduler would run every five
minutes. The eight-week baseline backfill runs only on the first: backfilling
twice would count every past week twice and make ordinary values look
anomalous.

To look at what it wrote: the console's *Explore table items*, or

```bash
aws dynamodb query --table-name netpulse-demo-main   --key-condition-expression 'PK = :p' --expression-attribute-values '{":p":{"S":"TENANT#hhs-demo#COMMSINC"}}'
```

### Pointing the board at the API

`terraform output vercel_env` prints four variables; the fourth is
`VITE_BOARD_API_URL`, and `pnpm web:env` writes it with the other three.
With it set the board reads its two data views from the API; remove the
line and it computes them in the tab instead. Sign-in is the pool either way.

What moves to the API is what reads DATA: the network view and the comms
view. The health replay, the live alarm feed and the assistant stay in the
tab - the first two play back recorded scenarios, and the assistant runs on
the offline Bedrock stand-in, so a Lambda would add a deploy without making
it any more real.

A quick check once applied - no token is a 401 from the gateway itself,
without invoking the Lambda:

```bash
curl -i "$(terraform output -json vercel_env | node -pe 'JSON.parse(require("fs").readFileSync(0)).VITE_BOARD_API_URL')/board"
```

Cost: $1.00 per million requests, and Lambda at 512 MB inside the free tier
at any volume a few people generate. The stage throttle (10/s, bursts of 20)
is the ceiling.

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
