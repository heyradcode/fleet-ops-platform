# Infrastructure

```
modules/    reusable building blocks, one concern each
stack/      the whole platform wired together, defined ONCE
envs/       dev | test | stage | prod — backend, provider, one module call
```

Each environment is a ~60-line wrapper around `stack/` - no `variables.tf`, no
`terraform.tfvars`, and exactly two variable declarations (the secrets CI
injects). See `docs/08-terraform-cicd.md` for how the input surface was kept
that small, the dependency-cycle fix, and the deploy pipeline.

## Reading order

1. `stack/main.tf` — how everything connects, and the per-function IAM. Note how
   different each Lambda's permissions are; that difference is the whole point
   of not sharing one role.
2. `modules/lambda/main.tf` — the module every function goes through, so the
   fleet gets log retention, alarms and least-privilege IAM for free.
3. `modules/cognito/main.tf` — five identity providers and a hardened app client.
4. `modules/dynamodb/main.tf` — single-table keys, GSI projection, streams, TTL,
   and the `dynamodb:LeadingKeys` tenant-isolation policy.
5. Whichever of the others you need.

## A note on file layout

Production Terraform splits each module into `main.tf` / `variables.tf` /
`outputs.tf`. They are combined here so each module reads top-to-bottom as one
story — variables, resources, outputs — which is better for learning and worse
for a real repo. `stack/` does use the conventional split.

## Running it

You cannot apply this as-is; it references placeholder account IDs, VPC IDs and
an OpenSearch collection ARN. To make it real you would need:

- Four AWS accounts (or one, with four state keys, if you must)
- An S3 state bucket per account
- A `netpulse-deploy` IAM role per account trusting your GitHub repo via OIDC
- A VPC with private subnets for Aurora
- An OpenSearch Serverless collection and vector index for the knowledge base
- Bedrock model access enabled in the region

To check syntax without any of that:

```bash
cd envs/dev
terraform init -backend=false
terraform validate
terraform fmt -check -recursive ../..
```

This is what CI does, and it needs no AWS credentials — which matters, because a
pull request from a fork must never have access to your cloud account.
