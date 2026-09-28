# =============================================================================
# AgentCore Gateway: the governed front door to the MCP tool server
# =============================================================================
#   agent ──Bearer <the user's token>──▶ Gateway   JWT inbound: the SAME pool
#                                           │       and client as everything
#                                           │       else - its own decision,
#                                           │       not offloaded
#                                           │ JWT_PASSTHROUGH: the same token,
#                                           ▼ unchanged
#                                      MCP runtime (mcp.tf) - accepts calls
#                                      from THIS gateway and nothing else
#
# WHY AN "AgentCore Runtime" TARGET, not an "MCP server" target. An MCP-type
# gateway aggregates tools and indexes them for semantic search, but it
# reaches an MCP-server target as ITSELF - IAM, an API key, OAuth client
# credentials - or by on-behalf-of token exchange, which needs an identity
# provider that implements RFC 8693/7523. Cognito user pools do not. Either
# way the tool would stop knowing who asked, and a Dallas operator's question
# would be answered with the tenant's reach. It would also sync ONE tools/list
# for everyone, where ours is per caller (5 tools for an operator, 10 for an
# HHS admin). A Runtime target forwards the request as it came, token
# included, so every rule in src/ai/mcp/ holds unchanged behind the gateway.
# (docs/12, Part 2 - "Behind the AgentCore Gateway".)
#
# THE CAVEAT, stated rather than hidden: AWS calls token passthrough right
# for onboarding and recommends on-behalf-of exchange for production, because
# the same token is accepted at two hops. That is already true here - the
# agent relays the user's token to the MCP runtime without the gateway - so
# passthrough adds a hop that checks the token, not a new place it is
# accepted. OBO is the upgrade once the pool is behind an IdP that can do it.
#
# WHAT THE GATEWAY ADDS: a single entry point that validates the token BEFORE
# anything reaches our code, per-target metrics and traces in CloudWatch, and
# the attachment point for AgentCore Policy (Cedar) and interceptors - rules
# enforced outside the agent's own environment. What it does not add is tool
# aggregation or semantic search; those are the MCP-type gateway's.
#
# COST: per request, fractions of a cent at demo volume. The gateway is idle
# when nobody asks anything.

locals {
  # Gateway and target names: letters, digits and single hyphens.
  gateway_name        = "${local.name_prefix}-mcp-gateway"
  gateway_target_name = "tools"
}

# The trust policy is main.tf's: AgentCore, for THIS account's resources only.
# No permissions are attached. With JWT passthrough the gateway signs nothing
# and fetches no credential - the user's token is the credential - so a role
# with rights would be rights nobody uses.
resource "aws_iam_role" "gateway" {
  count              = var.mcp_via_gateway ? 1 : 0
  name               = local.gateway_name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

resource "aws_bedrockagentcore_gateway" "mcp" {
  count       = var.mcp_via_gateway ? 1 : 0
  name        = local.gateway_name
  description = "Front door to the NetPulse MCP tool server - validates the user's token, then passes it through"
  role_arn    = aws_iam_role.gateway[0].arn

  # NO protocol_type. AgentCore Runtime targets cannot be added to an
  # MCP-type gateway - that type is the aggregating one described above.

  # The gateway's OWN check, before anything is forwarded: signature, issuer,
  # expiry, client_id. Not AUTHENTICATE_ONLY (that is SigV4 and carries no
  # bearer token to pass through) and not NONE (which would leave the
  # decision to the target alone). allowed_clients, never allowed_audience:
  # a Cognito access token has no `aud`.
  authorizer_type = "CUSTOM_JWT"
  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url   = "${local.cognito_issuer}/.well-known/openid-configuration"
      allowed_clients = [local.cognito_client]
    }
  }
}

resource "aws_bedrockagentcore_gateway_target" "mcp" {
  count              = var.mcp_via_gateway ? 1 : 0
  gateway_identifier = aws_bedrockagentcore_gateway.mcp[0].gateway_id
  name               = local.gateway_target_name
  description        = "The MCP runtime, reached with the caller's own token"

  target_configuration {
    http {
      agentcore_runtime {
        arn       = aws_bedrockagentcore_agent_runtime.mcp.agent_runtime_arn
        qualifier = "DEFAULT"
        # No schema: for an MCP-protocol runtime a default one is applied.
      }
    }
  }

  # The user's token, unchanged. The MCP server re-verifies it with all
  # seven checks and scopes every tool by it, exactly as without the gateway.
  credential_provider_configuration {
    jwt_passthrough {}
  }
}

output "mcp_gateway_url" {
  description = "The gateway in front of the MCP runtime; the agent calls {origin}/tools/invocations."
  value       = try(aws_bedrockagentcore_gateway.mcp[0].gateway_url, null)
}
