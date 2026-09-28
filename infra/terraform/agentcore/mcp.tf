# =============================================================================
# The MCP tool server: a second AgentCore runtime, speaking MCP
# =============================================================================
# The agent's read tools, served over the Model Context Protocol by their own
# runtime (infra/terraform/agentcore/mcp-entry.ts -> src/ai/mcp/):
#
#   agent microVM ──Bearer <the CALLER's access token>──▶ MCP runtime  POST /mcp
#                   (the token the board sent the agent)   │ AgentCore Identity:
#                                                          │ same pool, same client
#                                                          ▼
#                                                microVM: `node mcp.js` :8000
#                                                          │ re-verifies (7 checks)
#                                                          ├─▶ DynamoDB, READ, scoped
#                                                          │   to the caller's tenant
#                                                          └─▶ PutItem ONLY into
#                                                              TENANT#*#AUDIT
#
# WHY A SEPARATE RUNTIME rather than tools in the agent: a boundary the agent
# cannot talk its way through. The agent's role no longer needs the table at
# all when use_mcp_tools is on; the tools' role cannot call a model; and the
# server writes an audit row for every call, which the agent cannot skip
# because it never touches the tools directly.
#
# The user's token, not a service identity - which is also why the agent
# calls this runtime DIRECTLY and not through AgentCore Gateway: Gateway's
# outbound auth to a target is IAM, an API key or OAuth client credentials,
# all of them the gateway's identity. A Dallas operator's question answered
# with the gateway's identity is an answer about the whole tenant.
# (docs/12-ai-orchestration-mcp-knowledge-graph.md, Part 2.)
#
# COST: like the agent, CPU only while computing and memory while a session
# is warm. A tool call is milliseconds of CPU.

data "archive_file" "mcp" {
  type             = "zip"
  source_dir       = "${path.module}/.build/mcp"
  output_path      = "${path.module}/.build/mcp.zip"
  output_file_mode = "0644"
}

# Content-hashed key, create-before-destroy: the agent's reasons, in main.tf.
resource "aws_s3_object" "mcp" {
  bucket = aws_s3_bucket.code.id
  key    = "mcp/${data.archive_file.mcp.output_md5}.zip"
  source = data.archive_file.mcp.output_path
  etag   = data.archive_file.mcp.output_md5

  lifecycle {
    create_before_destroy = true
  }
}

# Named *-agent-runtime so the deploy policy's PassRole glob
# (netpulse-*-agent-runtime) already covers it.
resource "aws_iam_role" "mcp" {
  name               = "${local.name_prefix}-mcp-agent-runtime"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "mcp" {
  source_policy_documents = [data.aws_iam_policy_document.observability.json]

  statement {
    sid       = "ReadTheTable"
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [local.main_table_arn, "${local.main_table_arn}/index/GSI1"]
  }

  # The audit trail, and nothing else. `LeadingKeys` is matched against the
  # partition key of the item written: TENANT#<tenant>#AUDIT and no other
  # partition. A bug - or a tool someone later makes "helpful" - that tried to
  # put a device or an incident fails here as AccessDenied. PutItem only: an
  # audit row is appended, never updated or deleted by the thing it audits.
  statement {
    sid       = "AppendTheAuditTrail"
    actions   = ["dynamodb:PutItem"]
    resources = [local.main_table_arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["TENANT#*#AUDIT"]
    }
  }

  statement {
    sid       = "ReadOwnCode"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.code.arn}/*"]
  }
}

resource "aws_iam_role_policy" "mcp" {
  name   = "${local.name_prefix}-mcp-agent-runtime"
  role   = aws_iam_role.mcp.id
  policy = data.aws_iam_policy_document.mcp.json
}

resource "aws_bedrockagentcore_agent_runtime" "mcp" {
  agent_runtime_name = replace("${local.name_prefix}-mcp", "-", "_")
  description        = "NetPulse read tools over MCP - src/ai/mcp/server.ts, with an audit trail"
  role_arn           = aws_iam_role.mcp.arn

  agent_runtime_artifact {
    code_configuration {
      entry_point = ["mcp.js"]
      runtime     = "NODE_22"
      code {
        s3 {
          bucket = aws_s3_bucket.code.id
          prefix = aws_s3_object.mcp.key
        }
      }
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  # MCP: AgentCore expects 0.0.0.0:8000 and POST /mcp, stateless streamable
  # HTTP, and assigns Mcp-Session-Id itself. Without this the runtime is
  # treated as HTTP (:8080 /invocations) and every call is a 404 from a
  # server that is running perfectly well.
  protocol_configuration {
    server_protocol = "MCP"
  }

  # The SAME pool and client as the agent: the token that reaches this
  # runtime is the person's, relayed by the agent - so it must pass the check
  # the person's token passed at the agent.
  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url   = "${local.cognito_issuer}/.well-known/openid-configuration"
      allowed_clients = [local.cognito_client]

      # Behind the gateway, ONLY the gateway. A front door that can be walked
      # around is decoration: without this, anyone holding a valid token
      # could call the runtime's own address and skip every check the
      # gateway adds. The gateway stamps its identity on what it forwards;
      # the runtime rejects requests whose chain does not include it.
      dynamic "allowed_workload_configuration" {
        for_each = var.mcp_via_gateway ? [1] : []
        content {
          hosting_environment {
            arn = aws_bedrockagentcore_gateway.mcp[0].gateway_arn
          }
        }
      }
    }
  }

  # As for the agent: no header reaches the microVM unless allowlisted.
  request_header_configuration {
    request_header_allowlist = ["Authorization"]
  }

  environment_variables = {
    TABLE_NAME            = local.main_table_name
    COGNITO_ISSUER        = local.cognito_issuer
    COGNITO_APP_CLIENT_ID = local.cognito_client
    NETPULSE_REGION       = var.region
  }

  lifecycle_configuration {
    idle_runtime_session_timeout = var.idle_session_timeout_seconds
    max_lifetime                 = 3600
  }

  depends_on = [aws_iam_role_policy.mcp]
}

output "mcp_runtime_arn" {
  description = "The MCP tool server. The agent reaches it when use_mcp_tools is true."
  value       = aws_bedrockagentcore_agent_runtime.mcp.agent_runtime_arn
}
