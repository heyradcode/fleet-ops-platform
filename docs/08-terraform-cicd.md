# Terraform and CI/CD

## Layout

```
infra/terraform/
├── modules/            reusable building blocks
│   ├── cognito/        user pool + 5 identity providers + app client
│   ├── dynamodb/       single table + GSI + streams + TTL
│   ├── lambda/         role, log group, alarms, alias — used by every function
│   ├── appsync/        API, data sources, resolvers, caching
│   ├── api-gateway/    HTTP API, authorizers, routes, access logs
│   ├── eventbridge/    custom bus, rules, scheduler, DLQ, archive
│   ├── step-functions/ state machine + logging + alarms
│   ├── aurora-postgis/ Serverless v2 cluster + Data API + security group
│   └── s3-bedrock-kb/  raw bucket + knowledge base + guardrail
├── stack/              the whole platform, wired together, ONCE
└── envs/
    ├── dev/main.tf     backend + provider + module call   (~60 code lines)
    ├── test/main.tf
    ├── stage/main.tf
    └── prod/main.tf
```

The **stack** module is the important structural choice. Each environment is a
short wrapper around it, so the four environments are provably identical except
for their inputs. Adding a fifth is a directory, not a refactor.

---

## Keeping the environment roots small

"Share the stack" is only half the job. The other half is making sure the
wrapper around it is short — otherwise you have factored out the infrastructure
and left the boilerplate multiplied by four.

**The constraint:** a Terraform root module **cannot inherit variable
declarations**. There is no `include`. If a root passes `var.vpc_id` to a child,
the root must declare `variable "vpc_id"` itself. So every variable the stack
exposes is a block of boilerplate × the number of environments. Minimising the
stack's *input surface* is therefore the lever, not clever file layout.

Three rules do most of the work:

**1. Derive anything derivable.** `callback_urls`, `logout_urls` and
`cors_origins` were three variables that always moved together — the definition
of one variable wearing three hats. Now one `app_origin` goes in:

```hcl
callback_urls = concat(["${var.app_origin}/auth/callback"], var.extra_callback_urls)
logout_urls   = ["${var.app_origin}/"]
cors_origins  = [var.app_origin]
```

Besides being shorter, this removes a failure mode: an environment can no longer
end up with a CORS allow-list that disagrees with its Cognito callback URL.

**2. Discover anything discoverable.** The VPC is not created here — networking
is a separate, longer-lived stack that outlives any one application, and you do
not want an application `destroy` near it. So find it by tag rather than accept
three more ids:

```hcl
data "aws_vpc" "main" { tags = { Name = "netpulse-${var.env}" } }

data "aws_subnets" "private" {
  filter { name = "vpc-id", values = [data.aws_vpc.main.id] }
  tags   = { Tier = "private" }
}
```

The trade-off is an **implicit contract**: the network stack must tag things
this way, and nothing enforces it. State that loudly or it becomes a debugging
session for whoever adds environment five. Once you have more than a couple of
cross-stack references, `terraform_remote_state` against the network stack's
outputs is the better choice — explicit and versioned, at the cost of granting
read access to that state file.

The **Lambda security group** does belong to this stack, though: it is
application-scoped, it changes when the application changes, and Aurora's
ingress rule references it. Creating it here means "which SG may reach the
database" has exactly one answer, in one file.

**3. Push environment differences into the stack.** Log retention, Aurora
capacity, PITR, MFA and provisioned concurrency are all `var.env` conditionals
inside the modules — not inputs each root has to restate.

### What's left, and what a root actually looks like

```hcl
module "stack" {
  source = "../../stack"

  env        = "prod"
  aws_region = "us-east-1"
  app_origin = "https://app.netpulse.example.com"

  saml_metadata_url = "https://acme.example.com/FederationMetadata/…"
  oidc_issuer       = "https://acme.okta.com/oauth2/default"

  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
}

variable "google_client_id" {
  type      = string
  sensitive = true
}

variable "google_client_secret" {
  type      = string
  sensitive = true
}
```

There is **no `variables.tf` and no `terraform.tfvars`**. A root module is the
place where concrete values belong; routing them through `variable` + tfvars is
an indirection that only earns its keep for values injected *at apply time*.
Here that is two secrets, exported by CI as `TF_VAR_*` from Secrets Manager —
and two is the irreducible minimum.

### The residue

Two things genuinely cannot be factored out in plain Terraform, and it is worth
knowing which:

- **The `backend` block.** It permits no variables and no interpolation at all,
  so the bucket and key are duplicated per environment. Eliminating exactly this
  is what Terragrunt's `generate` block does, and it is the only reason here
  worth adopting it.
- **`output` blocks.** Also per-root. These could be collapsed into a single map
  output, but then `terraform output -raw rest_endpoint` in the deploy pipeline
  becomes `terraform output -json … | jq -r`, which is a real ergonomic cost for
  a cosmetic win. They are a published interface, not boilerplate — left flat.

### What not to do

Collapsing to **one root** with `-backend-config` and `-var-file` flags removes
the duplication too, and reintroduces exactly the failure mode the directory
split exists to prevent: one forgotten flag in CI and prod's plan runs against
the wrong state. The duplication is cheaper than that class of accident.

---

## Environments: directories, not workspaces

Terraform workspaces look tidier — one directory, `terraform workspace select
prod`. Don't.

Workspaces share **one backend key and one provider configuration**. Nothing
stops a mis-set `TF_WORKSPACE` from pointing a `destroy` at prod. Separate
directories, separate state files and — critically — **separate AWS accounts**
make that mistake impossible rather than merely discouraged.

Account separation also gives you independent service quotas, a clean blast
radius, and per-environment billing for free.

---

## State

```hcl
backend "s3" {
  bucket       = "netpulse-tfstate-444455556666"
  key          = "prod/terraform.tfstate"
  region       = "us-east-1"
  encrypt      = true
  use_lockfile = true      # Terraform 1.10+; replaced the DynamoDB lock table
}
```

**Locking is not optional.** Two concurrent CI applies without it will corrupt
state. On Terraform < 1.10 you need `dynamodb_table` instead.

**Secrets and state:** `sensitive = true` redacts a value from **output**. It
does **not** encrypt it in **state** — state is plaintext JSON, and every secret
Terraform touches is in there. So: encrypt the bucket, version it, lock it down,
and give nobody console read access. Inject secrets as `TF_VAR_*` from Secrets
Manager at apply time rather than committing tfvars.

---

## Module design

The `lambda` module is the one to look at. Every function in the platform goes
through it, so the whole fleet gets the same treatment without anyone having to
remember:

- An **explicit log group** with retention. If you let Lambda create it
  implicitly, retention is NEVER EXPIRE and the CloudWatch bill grows forever.
  This is the highest-value three lines in the file.
- **Least-privilege IAM.** Logging scoped to *this function's* log group, not
  `logs:*` on `*` the way the managed basic-execution policy does it. Extra
  permissions arrive as a typed `policy_statements` variable.
- **X-Ray tracing**, alias + version (so gradual deployment is possible), ARM64,
  and **two alarms**: `Errors` and `Throttles`. Throttles mean a concurrency
  limit — a different problem needing a different fix, so it gets its own alarm.

Look at how *different* the per-function permissions are in `stack/main.tf`:

| Function | Permissions |
|---|---|
| authorizer | **none** — verifying a JWT only needs a public JWKS fetch |
| pre-token | `dynamodb:GetItem` on one table |
| pipeline | `s3:PutObject` on `raw/*` only — it has no business *reading* the archive |
| graphql | DynamoDB, Bedrock (specific model ARNs), Aurora Data API, EventBridge |

That difference is the entire point of not using one shared role. `bedrock:
InvokeModel` on `"*"` would let a compromised function run any model in any
region, on your bill.

---

## Breaking dependency cycles

A real problem you hit within an hour of writing modules:

```
eventbridge    needs the state machine ARN   (the schedule targets it)
step_functions needs the bus ARN             (the failure path publishes to it)
```

Terraform builds its graph from references, so wiring both directions through
module outputs is a literal cycle and `plan` fails.

**The fix:** construct the name/ARN of one side from known values instead of
reading it back out of the module. Bus names are deterministic:

```hcl
event_bus_name = "${local.name_prefix}-bus"
event_bus_arn  = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:event-bus/${local.name_prefix}-bus"
```

The alternative — splitting into two states joined by `terraform_remote_state` —
is worse: two applies and a partially-deployed window between them.

→ `infra/terraform/stack/main.tf`, with the reasoning in a comment

---

## What varies by environment

Driven off `var.env` rather than duplicated config:

| | dev | prod |
|---|---|---|
| Log retention | 14 days | 90 days |
| Aurora auto-pause | 15 min → **zero** | never |
| Aurora capacity | 0.5–2 ACU | 1–16 ACU, plus a reader |
| PITR / deletion protection | off | on |
| Cognito advanced security | AUDIT | ENFORCED |
| MFA | off | optional + TOTP |
| Provisioned concurrency | 0 | 2 on the auth path |
| AppSync field logs | ALL | ERROR (cost, and PII) |
| API throttle | 50 rps | 1000 rps |
| S3 retention | 30 days | 7 years |

---

## GitHub Actions

### CI — on every push and PR

```
app        npm ci → typecheck → test → npm start (the demo IS a smoke test)
terraform  fmt -check → init -backend=false → validate   (matrix × 4 envs)
security   Trivy config scan → SARIF to the Security tab → npm audit
```

`-backend=false` means validation needs **no AWS credentials**, which matters
because a PR from a fork must never have access to your cloud account.

`npm ci`, not `npm install`: it installs exactly the lockfile and fails if
`package.json` and the lock have drifted.

### Deploy — dev → test → stage → prod

Two things make it a grown-up pipeline.

**1. No long-lived AWS keys.** GitHub's OIDC provider issues a short-lived
token; AWS trusts it via a role whose trust policy pins the repo **and** the
environment:

```json
"token.actions.githubusercontent.com:sub": "repo:acme/netpulse:environment:prod"
```

A wildcard subject like `repo:acme/*:*` would let any branch of any repo in the
org assume the prod deploy role. Pin it.

**2. Promotion, not rebuild.** The artefact is built **once** and the same bytes
move through every environment. Rebuild per environment and you tested one
artefact and shipped a different one.

Between test and stage, a real **integration suite** runs against the deployed
API with a real Cognito token. That is the step that catches IAM permission
mistakes, which no amount of local testing or `terraform validate` ever will.

Manual approval before prod is a GitHub **Environment protection rule** —
required reviewers — not a workflow step. Don't try to fake it with an `if:`.

### Guarding the apply

```bash
terraform plan -input=false -out=tfplan -detailed-exitcode
# exit 0 = no changes, 1 = error, 2 = changes present
```

Exit code 2 is what lets you skip a pointless apply *and* notice that a "no-op"
deploy is unexpectedly planning to replace the database.

Then, in prod only, fail the job if the plan deletes or replaces anything:

```bash
terraform show -json tfplan \
  | jq '[.resource_changes[] | select(.change.actions | index("delete"))] | length'
```

The environment gate covers approval; this covers "the reviewer approved without
reading the plan".

### Concurrency

```yaml
# CI: cancel superseded runs — a busy PR shouldn't queue five identical runs
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }

# Deploy: NEVER cancel — killing a half-finished apply leaves state locked
concurrency: { group: deploy-${{ inputs.environment }}, cancel-in-progress: false }
```

### Migrations

`CREATE EXTENSION postgis` is SQL, not a Terraform resource. Schema changes run
as a **separate pipeline step after apply**, where they can be reviewed and
rolled back independently of the infrastructure hosting them.

Same for the knowledge base: `aws s3 sync` the runbooks, then
`start-ingestion-job`. Uploading without starting an ingestion job means Bedrock
silently keeps serving the previous version — a genuinely confusing bug.

→ `.github/workflows/{ci,deploy,terraform-apply}.yml`
