# =============================================================================
# The board API: GET /board and GET /comms, over the real table
# =============================================================================
# One Lambda (src/api/board-api.ts, entered through api-entry.ts) behind an
# HTTP API. The board calls it with the Cognito ACCESS token when
# VITE_BOARD_API_URL is set; without it the board keeps computing in the tab.
#
# HTTP API, not REST API: a native JWT authorizer, ~70% cheaper ($1.00 per
# million requests), and nothing here needs what REST adds (API keys, WAF,
# request validation).
#
# TWO CHECKS OF ONE TOKEN, on purpose. The gateway's JWT authorizer verifies
# signature, issuer, expiry and client id, and rejects everything else before
# the Lambda is invoked - so anonymous traffic costs a gateway request and
# not a Lambda invocation. It does NOT check token_use (an ID token from the
# same pool passes) or that a tenant claim exists; the Lambda re-verifies
# with all seven checks, and the tenant claim is the boundary itself.
#
# READ-ONLY. The Lambda's policy is GetItem and Query on the main table.
# Writes happen in `pnpm seed:aws` under someone's own credentials; an API
# that can only read cannot be talked into writing.

locals {
  # Where the board is served from. The same list the pool's logout URLs use,
  # so a deployed origin and localhost:5180 are both allowed and nothing else.
  board_origins = local.logout_urls
}

module "board_api" {
  source = "../modules/lambda"

  name       = "${local.name_prefix}-board-api"
  env        = var.env
  handler    = "index.handler"
  source_dir = "${path.module}/.build/board-api"

  # The network view replays six scenarios through the pipeline on every
  # request; 512 MB buys the CPU for that in well under a second. Lambda CPU
  # scales with memory, so less memory is not cheaper if it runs longer.
  memory_mb       = 512
  timeout_seconds = 10

  environment = {
    TABLE_NAME            = aws_dynamodb_table.main.name
    COGNITO_ISSUER        = module.cognito.issuer
    COGNITO_APP_CLIENT_ID = module.cognito.client_id
  }

  policy_statements = [{
    actions = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [
      aws_dynamodb_table.main.arn,
      "${aws_dynamodb_table.main.arn}/index/GSI1",
    ]
  }]

  # No reserved concurrency: a new account's pool is small enough that
  # reserving any of it can fail the apply. The stage throttle below is the
  # cost ceiling instead.
}

resource "aws_apigatewayv2_api" "board" {
  name          = "${local.name_prefix}-board-api"
  protocol_type = "HTTP"

  # The gateway answers CORS preflights itself - an OPTIONS request carries no
  # token, so it could not pass the authorizer and must never reach it.
  cors_configuration {
    allow_origins = local.board_origins
    allow_methods = ["GET"]
    allow_headers = ["authorization"]
    max_age       = 600
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.board.id
  authorizer_type  = "JWT"
  name             = "cognito-access-token"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer = module.cognito.issuer
    # For an ACCESS token, which has no `aud`, the gateway matches this list
    # against the `client_id` claim instead.
    audience = [module.cognito.client_id]
  }
}

resource "aws_apigatewayv2_integration" "board" {
  api_id                 = aws_apigatewayv2_api.board.id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.board_api.arn
  payload_format_version = "2.0"
}

# Explicit routes, not $default: a path nobody declared is a 404 from the
# gateway and never an invocation.
resource "aws_apigatewayv2_route" "board" {
  for_each = toset(["GET /board", "GET /comms"])

  api_id             = aws_apigatewayv2_api.board.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.board.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.board.id
  name        = "$default"
  auto_deploy = true

  # The cost ceiling. Ten requests a second, bursts of twenty: far above what
  # a few people on a board generate, and a hard stop on anything that is
  # not - at worst ~26M requests a month, and the budget alarm fires long
  # before that.
  default_route_settings {
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }
}

# Scoped to THIS API's routes, not to API Gateway at large.
resource "aws_lambda_permission" "board_api" {
  statement_id  = "AllowBoardApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.board_api.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.board.execution_arn}/*/*"
}
