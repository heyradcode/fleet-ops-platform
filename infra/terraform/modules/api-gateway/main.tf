# =============================================================================
# API Gateway HTTP API (v2)
# =============================================================================
# HTTP API rather than REST API: ~70% cheaper, lower latency, and it has a
# native JWT authorizer. Choose REST API only when you specifically need
# request validation, API keys and usage plans, WAF, private endpoints or
# canary deployments.

variable "name_prefix" { type = string }
variable "env" { type = string }
variable "rest_lambda_arn" { type = string }
variable "authorizer_lambda_arn" { type = string }
variable "cognito_issuer" { type = string }
variable "cognito_client_id" { type = string }
variable "cors_origins" { type = list(string) }

resource "aws_apigatewayv2_api" "main" {
  name          = "${var.name_prefix}-http"
  protocol_type = "HTTP"

  cors_configuration {
    # Never "*" together with credentials - browsers reject it, and if they did
    # not it would let any site read authenticated responses.
    allow_origins     = var.cors_origins
    allow_methods     = ["GET", "POST", "OPTIONS"]
    allow_headers     = ["authorization", "content-type", "x-webhook-signature"]
    allow_credentials = true
    max_age           = 300
  }
}

# -----------------------------------------------------------------------------
# Two authorizers, because there are two kinds of caller
# -----------------------------------------------------------------------------

# 1. JWT authorizer - zero code. API Gateway validates the Cognito token
#    itself. Use this whenever "is the token valid" is the entire rule.
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.main.id
  name             = "cognito-jwt"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = var.cognito_issuer
    audience = [var.cognito_client_id]
  }
}

# 2. Lambda authorizer - for decisions that need our own data (tenant status,
#    subscription tier, per-route roles).
resource "aws_apigatewayv2_authorizer" "lambda" {
  api_id                            = aws_apigatewayv2_api.main.id
  name                              = "tenant-authorizer"
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = var.authorizer_lambda_arn
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = false # we return an IAM policy
  identity_sources                  = ["$request.header.Authorization"]

  # THE performance setting. Without it you invoke the authorizer on every
  # single request. With it, one invocation per token per TTL.
  #
  # The trap: the cached result is keyed on the identity source, NOT the path.
  # So the policy you return must cover the whole API (wildcard resource) and
  # per-route rules must be enforced downstream from the `context` you pass.
  authorizer_result_ttl_in_seconds = 300
}

# -----------------------------------------------------------------------------
# Integration + routes
# -----------------------------------------------------------------------------

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.rest_lambda_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000 # API Gateway's own hard ceiling is 30s
}

locals {
  # route => whether it needs auth
  routes = {
    "GET /health"               = false
    "GET /sites"                = true
    "GET /sites/{siteId}"       = true
    "GET /sites/near"           = true
    "GET /signals"              = true
    "GET /incidents"            = true
    "GET /map"                  = true
    "POST /ask"                 = true
    "POST /incidents"           = true
    # Webhooks authenticate with an HMAC signature, not a JWT - the vendor has
    # no Cognito token. Verify the signature inside the handler.
    "POST /webhooks/{provider}" = false
  }
}

resource "aws_apigatewayv2_route" "routes" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"

  authorization_type = each.value ? "CUSTOM" : "NONE"
  authorizer_id      = each.value ? aws_apigatewayv2_authorizer.lambda.id : null
}

# -----------------------------------------------------------------------------
# Stage
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name_prefix}-http"
  retention_in_days = var.env == "prod" ? 90 : 14
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn

    # Structured access logs. `integrationErrorMessage` is the field that tells
    # you WHY a 502 happened, and it is the one people forget to include.
    format = jsonencode({
      requestId               = "$context.requestId"
      ip                      = "$context.identity.sourceIp"
      requestTime             = "$context.requestTime"
      httpMethod              = "$context.httpMethod"
      routeKey                = "$context.routeKey"
      status                  = "$context.status"
      protocol                = "$context.protocol"
      responseLength          = "$context.responseLength"
      integrationLatency      = "$context.integrationLatency"
      authorizerError         = "$context.authorizer.error"
      integrationErrorMessage = "$context.integrationErrorMessage"
      tenantId                = "$context.authorizer.tenantId"
    })
  }

  default_route_settings {
    # Protects your Lambda concurrency (and your bill) from a single client.
    # Per-client quotas need a REST API with usage plans, or WAF rate rules.
    throttling_burst_limit = var.env == "prod" ? 2000 : 100
    throttling_rate_limit  = var.env == "prod" ? 1000 : 50
    detailed_metrics_enabled = true
  }
}

# API Gateway must be granted permission to invoke each Lambda. Forgetting this
# produces a 500 with no useful message - a classic first-deploy failure.
resource "aws_lambda_permission" "rest" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.rest_lambda_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "authorizer" {
  statement_id  = "AllowAPIGatewayInvokeAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = var.authorizer_lambda_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/authorizers/*"
}

output "api_endpoint" { value = aws_apigatewayv2_api.main.api_endpoint }
output "execution_arn" { value = aws_apigatewayv2_api.main.execution_arn }
