# =============================================================================
# The one root in this repository that is meant to be applied
# =============================================================================
# Everything else under infra/ is read-only demonstration material describing
# the full platform. This is the subset that runs the board's identity for real,
# and it was chosen on cost as much as on value:
#
#   Cognito user pool        free up to 10,000 monthly active users
#   PreTokenGeneration       inside the Lambda free tier at any demo volume
#   CloudWatch log group     pennies, and capped at 14 days below
#
# Deliberately NOT here, and the reason in each case:
#
#   Aurora PostGIS   ~$87/month idle - two Serverless v2 instances at a 0.5 ACU
#                    floor, billed whether or not anything queries them. The
#                    PostGIS work is legible as SQL in geo/postgis-queries.ts
#                    and data/schema.sql; paying monthly to execute it buys
#                    nothing a reader cannot already see.
#   Kinesis          ~$29/month, no free tier. The batching lesson is fully
#                    visible in aws/kinesis.ts and in the demo output.
#   Bedrock KB       needs a vector store, and OpenSearch Serverless has a
#                    ~$700/month floor. Never wire this for a demo.
#
# Apply this, and the board signs people in against a real user pool with a
# real trigger stamping real signed claims. Everything else keeps running in
# the browser tab, which is the architecture, not a limitation.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    # The lambda module zips its source with archive_file. Declared here because
    # the module does not declare it, and an inferred provider is a warning
    # today and a hard error in some future version.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
  }

  # Local state, on purpose. Remote state with a DynamoDB lock table is right
  # for a team; for one operator applying one pool it adds a bucket, a table
  # and a bootstrap problem. envs/ shows the S3 backend for the real thing.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "meridian"
      ManagedBy = "terraform"
      Root      = "auth"
    }
  }
}

locals {
  name_prefix = "meridian-${var.env}"

  # Cognito matches redirect URIs EXACTLY - no trailing slash tolerance, no
  # wildcards. localhost is included so the same pool serves local development;
  # it is not a hole, because a token still has to come from this pool.
  callback_urls = concat(
    [for url in var.app_urls : "${url}/callback"],
    ["http://localhost:5180/callback"],
  )

  logout_urls = concat(var.app_urls, ["http://localhost:5180"])
}

# -----------------------------------------------------------------------------
# The trigger
# -----------------------------------------------------------------------------
# Bundled by `pnpm build:lambda`, which esbuilds src/auth/pre-token-generation.ts
# and everything it imports into .build/pre-token-generation/index.mjs.
#
# This is the piece that makes the board's scope real. Without it a user signs
# in successfully and arrives with no tenant claim, so the verifier rejects the
# token and the board shows nothing - which is the correct fail-closed
# behaviour, and an alarming thing to debug if you did not expect it.

module "pre_token" {
  source = "../modules/lambda"

  name       = "${local.name_prefix}-pre-token"
  env        = var.env
  handler    = "index.handler"
  source_dir = "${path.module}/.build/pre-token-generation"

  # A token trigger runs on the login path, so it is latency-sensitive - but
  # not enough to pay for provisioned concurrency on a demo. 256MB is plenty
  # for a table lookup and a base64 encode.
  memory_mb       = 256
  timeout_seconds = 5

  # Cognito's own timeout for this trigger is 5 seconds and it is not
  # configurable, so a longer Lambda timeout would only burn money before
  # Cognito gave up anyway.

  environment = {
    # Unset means the built-in carrier table, which is how the demo and the
    # tests run. Terraform always sets it, so the fallback firing in a
    # deployed function is a deployment bug and lambda-entry.ts logs it.
    MEMBERSHIP_TABLE_NAME = aws_dynamodb_table.membership.name
  }

  # ONE action, on ONE table. The trigger reads membership and does nothing
  # else, and this runs on the login path for every user in the system - the
  # blast radius of a mistake here is everyone.
  policy_statements = [{
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.membership.arn]
  }]
}

# Cognito must be allowed to invoke it, and the permission is scoped to THIS
# pool - not to the service at large. Without source_arn, any Cognito pool in
# any account could invoke this function.
resource "aws_lambda_permission" "cognito" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.pre_token.name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = module.cognito.user_pool_arn
}

# -----------------------------------------------------------------------------
# The pool
# -----------------------------------------------------------------------------

module "cognito" {
  source = "../modules/cognito"

  name_prefix = local.name_prefix
  env         = var.env

  callback_urls = local.callback_urls
  logout_urls   = local.logout_urls

  pre_token_generation_lambda_arn = module.pre_token.arn

  # Globally unique across all of AWS. Leave it empty and it derives from the
  # name prefix; set it if the apply tells you the domain is taken.
  domain_prefix = var.domain_prefix

  # The hosted UI's stylesheet, kept beside this file rather than inline - it
  # is CSS, and it deserves an editor that knows that.
  ui_css = file("${path.module}/hosted-ui/theme.css")

  # Threat protection is the Cognito "Plus" feature plan. It is the highest
  # value paid feature on a real pool and pointless on a demo one, so it stays
  # off and the pool stays on the free plan.
  advanced_security_mode = "OFF"

  # Empty means "do not create it". Fill these in to add Google sign-in; the
  # module creates the social providers only when credentials exist, because a
  # provider with an empty client_id fails at apply time rather than at login.
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
}

# -----------------------------------------------------------------------------
# The cost guardrail
# -----------------------------------------------------------------------------
# Not optional. This root is cheap by construction, but a budget you set BEFORE
# the first apply is the only one that ever gets set, and the failure mode it
# guards against - noticing a bill four weeks late - is the expensive one.

resource "aws_budgets_budget" "guard" {
  name         = "${local.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # 50% of a $5 budget is $2.50, which for this stack means something is very
  # wrong and you want to hear about it early rather than accurately.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
