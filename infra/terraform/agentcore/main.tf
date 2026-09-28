# =============================================================================
# The assistant on Amazon Bedrock AgentCore Runtime
# =============================================================================
# The board's assistant - the agent loop in src/ai/agent-core.ts, its tools and
# guardrails - hosted by AgentCore instead of running in the browser tab:
#
#   board ──Bearer <Cognito ACCESS token>──▶ AgentCore Runtime endpoint
#          (browser, direct: the endpoint        │ AgentCore Identity checks the
#           answers CORS for any origin)         │ JWT against the pool - before
#                                                ▼ anything starts or is billed
#                                      microVM per session: `node agent.js`
#                                                │ re-verifies the token (7 checks)
#                                                ├─▶ Claude on Bedrock (or the
#                                                │   offline model, agent_model)
#                                                └─▶ DynamoDB, read-only, scoped
#                                                    to the caller's tenant
#
# docs/11-agentcore.md is the long form - how AgentCore works, and why each
# decision here was made.
#
# A SEPARATE ROOT from ../auth, deliberately. AgentCore resources exist only in
# AWS provider 6.x, and ../auth is pinned to 5.x with a working deployment
# behind it; a major provider upgrade is its own change, not a side effect of
# adding an agent. This root READS ../auth's state for the pool and the table,
# and changes nothing there.
#
# COST, at demo volume: the runtime bills CPU only while the agent is actually
# computing (waiting on the model or DynamoDB is free) and memory for the
# session's life - with the 5-minute idle timeout below, cents a month. The
# model is the real cost: per-token Bedrock pricing on every question, which
# is why agent_model is a variable and "offline" is a valid value.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # aws_bedrockagentcore_agent_runtime, with code_configuration.
      version = ">= 6.21, < 7.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "netpulse", env = var.env, root = "agentcore" }
  }
}

locals {
  name_prefix = "netpulse-${var.env}"
  # AgentCore runtime names allow letters, digits and underscores - no hyphen.
  runtime_name = replace("${local.name_prefix}-agent", "-", "_")
}

data "aws_caller_identity" "current" {}

# What ../auth created: the pool the board signs in to, and the table.
data "terraform_remote_state" "auth" {
  backend = "local"
  config  = { path = "${path.module}/../auth/terraform.tfstate" }
}

locals {
  account_id       = data.aws_caller_identity.current.account_id
  cognito_issuer   = data.terraform_remote_state.auth.outputs.vercel_env["VITE_COGNITO_ISSUER"]
  cognito_client   = data.terraform_remote_state.auth.outputs.vercel_env["VITE_COGNITO_CLIENT_ID"]
  main_table_name  = data.terraform_remote_state.auth.outputs.main_table_name
  main_table_arn   = "arn:aws:dynamodb:${var.region}:${local.account_id}:table/${local.main_table_name}"
  runtime_arn_glob = "arn:aws:bedrock-agentcore:${var.region}:${local.account_id}:*"
}

# -----------------------------------------------------------------------------
# The code: one bundled file, zipped, in S3
# -----------------------------------------------------------------------------
# `pnpm build:agent` writes .build/agent/{agent.js,package.json}. AgentCore
# reads the zip from S3 when the runtime is created or updated.

data "archive_file" "agent" {
  type        = "zip"
  source_dir  = "${path.module}/.build/agent"
  output_path = "${path.module}/.build/agent.zip"
  # AgentCore needs the files readable (644). A zip built on Windows carries
  # no Unix modes at all; this sets them explicitly.
  output_file_mode = "0644"
}

resource "aws_s3_bucket" "code" {
  bucket = "${local.name_prefix}-agent-code-${local.account_id}"
  # Build artefacts, rebuilt by `pnpm build:agent`; nothing here is data.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "code" {
  bucket                  = aws_s3_bucket.code.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "code" {
  bucket = aws_s3_bucket.code.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# The key CONTAINS the content hash. A new build is a new key, the runtime's
# artifact changes, and Terraform updates the runtime - a fixed key would
# leave the runtime pointing at the same S3 path with nothing telling it the
# bytes behind it changed.
resource "aws_s3_object" "agent" {
  bucket = aws_s3_bucket.code.id
  key    = "agent/${data.archive_file.agent.output_md5}.zip"
  source = data.archive_file.agent.output_path
  etag   = data.archive_file.agent.output_md5

  # New zip first, runtime moved to it, THEN the old zip removed. The default
  # order deletes the old object before the runtime update, leaving a window
  # where the runtime points at a key that no longer exists - and a session
  # cold-starting in it fails for a reason no log line explains.
  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# The execution role - what the agent's code may do
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
    # Confused-deputy protection: only AgentCore acting for THIS account's
    # runtimes may assume the role, not the service on anyone's behalf.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.runtime_arn_glob]
    }
  }
}

resource "aws_iam_role" "agent" {
  name               = "${local.name_prefix}-agent-runtime"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

# Logs, traces and metrics - where AgentCore sends a runtime's output. Shared
# by the agent and the MCP server (mcp.tf): the same service writes both.
data "aws_iam_policy_document" "observability" {
  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams",
    ]
    resources = [
      "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*",
      "arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*",
    ]
  }
  statement {
    sid       = "LogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:*"]
  }
  statement {
    sid       = "Traces"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
    resources = ["*"]
  }
  statement {
    sid       = "Metrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["bedrock-agentcore"]
    }
  }
}

data "aws_iam_policy_document" "agent" {
  source_policy_documents = [data.aws_iam_policy_document.observability.json]

  # The tools READ the operational store, and that is all. No PutItem: the
  # agent is offered no write tool, and if a future change offered one, the
  # write would fail here rather than page someone.
  statement {
    sid       = "ReadTheTable"
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [local.main_table_arn, "${local.main_table_arn}/index/GSI1"]
  }

  # The model. `bedrock-mantle:CreateInference` is the Messages-API endpoint's
  # action. Resource "*": the published guidance scopes it to model ARNs,
  # whose format for this endpoint is not pinned down anywhere we could
  # verify - a guessed ARN fails closed as AccessDenied on the first question.
  # Tighten it once the format is confirmed against a live call.
  statement {
    sid       = "InvokeClaude"
    actions   = ["bedrock-mantle:CreateInference"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadOwnCode"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.code.arn}/*"]
  }
}

resource "aws_iam_role_policy" "agent" {
  name   = "${local.name_prefix}-agent-runtime"
  role   = aws_iam_role.agent.id
  policy = data.aws_iam_policy_document.agent.json
}

# -----------------------------------------------------------------------------
# The runtime
# -----------------------------------------------------------------------------

resource "aws_bedrockagentcore_agent_runtime" "agent" {
  agent_runtime_name = local.runtime_name
  description        = "NetPulse operations assistant - the agent loop from src/ai/agent-core.ts"
  role_arn           = aws_iam_role.agent.arn

  agent_runtime_artifact {
    code_configuration {
      entry_point = ["agent.js"]
      runtime     = "NODE_22"
      code {
        s3 {
          bucket = aws_s3_bucket.code.id
          prefix = aws_s3_object.agent.key
        }
      }
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  # AgentCore Identity, inbound: only ACCESS tokens from the board's pool and
  # app client get as far as starting a microVM. `allowed_clients` is matched
  # against the token's `client_id` claim - a Cognito access token has no
  # `aud`, so allowed_audience would reject every one of them.
  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url   = "${local.cognito_issuer}/.well-known/openid-configuration"
      allowed_clients = [local.cognito_client]
    }
  }

  # AgentCore forwards NO request header it was not told to. Without this the
  # agent never sees the token, cannot derive a tenant, and answers 401 to a
  # request AgentCore itself just accepted.
  request_header_configuration {
    request_header_allowlist = ["Authorization"]
  }

  # Where the tools are is decided by which MCP variables are PRESENT (see
  # agent-entry.ts): the gateway's pair, else the runtime ARN, else none and
  # the tools run in the agent. Absent rather than "" when switched off, so
  # the fallback path never depends on an empty value being accepted.
  environment_variables = merge(
    {
      TABLE_NAME            = local.main_table_name
      COGNITO_ISSUER        = local.cognito_issuer
      COGNITO_APP_CLIENT_ID = local.cognito_client
      NETPULSE_REGION       = var.region
      AGENT_MODEL           = var.agent_model
      AGENT_FALLBACK_MODEL  = var.agent_fallback_model
    },
    var.use_mcp_tools ? tomap({
      MCP_RUNTIME_ARN = aws_bedrockagentcore_agent_runtime.mcp.agent_runtime_arn
    }) : tomap({}),
    # The gateway (gateway.tf), which the agent then prefers - the runtime
    # accepts nothing else once the gateway fronts it.
    var.use_mcp_tools && var.mcp_via_gateway ? tomap({
      MCP_GATEWAY_URL    = try(aws_bedrockagentcore_gateway.mcp[0].gateway_url, "")
      MCP_GATEWAY_TARGET = local.gateway_target_name
    }) : tomap({}),
  )

  # A session's microVM stays up (memory billed) until it has been idle this
  # long. Five minutes covers a person asking follow-ups; the default is 15.
  lifecycle_configuration {
    idle_runtime_session_timeout = var.idle_session_timeout_seconds
    max_lifetime                 = 3600
  }

  depends_on = [aws_iam_role_policy.agent]
}
