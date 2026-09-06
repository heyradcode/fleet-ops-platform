# =============================================================================
# AppSync GraphQL API
# =============================================================================

variable "name_prefix" { type = string }
variable "env" { type = string }
variable "schema_path" { type = string }

variable "resolver_code_dir" {
  description = "Directory holding the VTL / APPSYNC_JS resolver files."
  type        = string
}
variable "user_pool_id" { type = string }
variable "aws_region" { type = string }
variable "resolver_lambda_arn" { type = string }
variable "dynamodb_table_name" { type = string }
variable "dynamodb_table_arn" { type = string }

resource "aws_appsync_graphql_api" "main" {
  name   = "${var.name_prefix}-api"
  schema = file(var.schema_path)

  # PRIMARY auth: Cognito user pools, for humans.
  authentication_type = "AMAZON_COGNITO_USER_POOLS"

  user_pool_config {
    user_pool_id   = var.user_pool_id
    aws_region     = var.aws_region
    default_action = "DENY" # deny anything the schema does not explicitly allow
  }

  # ADDITIONAL auth: IAM, for the ingest pipeline calling publishSignal to
  # trigger subscription fan-out. Multiple auth modes on one API is a genuine
  # AppSync strength - the same schema serves humans and services, with
  # per-field control via @aws_iam / @aws_cognito_user_pools.
  additional_authentication_provider {
    authentication_type = "AWS_IAM"
  }

  # Full request/response logging in non-prod only. In prod it is expensive and
  # it will log user data into CloudWatch.
  log_config {
    cloudwatch_logs_role_arn = aws_iam_role.logs.arn
    field_log_level          = var.env == "prod" ? "ERROR" : "ALL"
    exclude_verbose_content  = var.env == "prod"
  }

  xray_enabled = true

  tags = {
    Environment = var.env
  }
}

# -----------------------------------------------------------------------------
# Data sources
# -----------------------------------------------------------------------------

# 1. DIRECT DynamoDB. No Lambda, no cold start, no per-invoke charge. This is
#    the right choice for any resolver that only reads or writes DynamoDB.
resource "aws_appsync_datasource" "dynamodb" {
  api_id           = aws_appsync_graphql_api.main.id
  name             = "MainTable"
  type             = "AMAZON_DYNAMODB"
  service_role_arn = aws_iam_role.datasource.arn

  dynamodb_config {
    table_name = var.dynamodb_table_name
    region     = var.aws_region
  }
}

# 2. Lambda, for everything that needs Bedrock, Aurora, or orchestration.
resource "aws_appsync_datasource" "lambda" {
  api_id           = aws_appsync_graphql_api.main.id
  name             = "ResolverLambda"
  type             = "AWS_LAMBDA"
  service_role_arn = aws_iam_role.datasource.arn

  lambda_config {
    function_arn = var.resolver_lambda_arn
  }
}

# 3. NONE. A local data source that runs a resolver without calling anything -
#    used for subscription resolvers and for pure field transformations.
resource "aws_appsync_datasource" "none" {
  api_id = aws_appsync_graphql_api.main.id
  name   = "NoneDataSource"
  type   = "NONE"
}

# -----------------------------------------------------------------------------
# Resolvers
# -----------------------------------------------------------------------------

# Query.signals: APPSYNC_JS unit resolver straight onto DynamoDB. No Lambda.
resource "aws_appsync_resolver" "query_signals" {
  api_id      = aws_appsync_graphql_api.main.id
  type        = "Query"
  field       = "signals"
  data_source = aws_appsync_datasource.dynamodb.name
  code        = file("${var.resolver_code_dir}/Query.signals.js")

  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
}

# Query.site: the older VTL style, kept as a reference. You will meet it.
resource "aws_appsync_resolver" "query_site" {
  api_id            = aws_appsync_graphql_api.main.id
  type              = "Query"
  field             = "site"
  data_source       = aws_appsync_datasource.dynamodb.name
  request_template  = file("${var.resolver_code_dir}/Query.site.request.vtl")
  response_template = file("${var.resolver_code_dir}/Query.site.response.vtl")
}

# Everything that needs real compute goes to the Lambda data source.
resource "aws_appsync_resolver" "lambda_backed" {
  for_each = {
    "Query.mapLayer"              = "Query"
    "Query.sitesNear"             = "Query"
    "Query.askRunbooks"           = "Query"
    "Query.incidents"             = "Query"
    "Mutation.openIncident"       = "Mutation"
    "Mutation.acknowledgeIncident" = "Mutation"
    "Mutation.askAgent"           = "Mutation"
    "Site.signals"                = "Site"
  }

  api_id      = aws_appsync_graphql_api.main.id
  type        = each.value
  field       = split(".", each.key)[1]
  data_source = aws_appsync_datasource.lambda.name
  kind        = "UNIT"
}

# -----------------------------------------------------------------------------
# Caching
# -----------------------------------------------------------------------------
# PER_RESOLVER_CACHING lets you set a TTL on the resolvers that are safe to
# cache (the map layer, the site list) and leave the rest uncached. The cache
# key includes $context.identity by default, so one tenant cannot be served
# another tenant's cached response - verify this if you ever set caching_keys
# by hand, because getting it wrong is a cross-tenant data leak.

resource "aws_appsync_api_cache" "main" {
  count = var.env == "prod" ? 1 : 0

  api_id                       = aws_appsync_graphql_api.main.id
  api_caching_behavior         = "PER_RESOLVER_CACHING"
  type                         = "SMALL"
  ttl                          = 30
  at_rest_encryption_enabled   = true
  transit_encryption_enabled   = true
}

# -----------------------------------------------------------------------------
# IAM
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "appsync_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["appsync.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "datasource" {
  name               = "${var.name_prefix}-appsync-datasource"
  assume_role_policy = data.aws_iam_policy_document.appsync_assume.json
}

data "aws_iam_policy_document" "datasource" {
  statement {
    actions = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [
      var.dynamodb_table_arn,
      "${var.dynamodb_table_arn}/index/*",
    ]
  }

  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [var.resolver_lambda_arn, "${var.resolver_lambda_arn}:*"]
  }
}

resource "aws_iam_role_policy" "datasource" {
  name   = "${var.name_prefix}-appsync-datasource"
  role   = aws_iam_role.datasource.id
  policy = data.aws_iam_policy_document.datasource.json
}

resource "aws_iam_role" "logs" {
  name               = "${var.name_prefix}-appsync-logs"
  assume_role_policy = data.aws_iam_policy_document.appsync_assume.json
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.logs.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppSyncPushToCloudWatchLogs"
}

output "graphql_endpoint" { value = aws_appsync_graphql_api.main.uris["GRAPHQL"] }
output "realtime_endpoint" { value = aws_appsync_graphql_api.main.uris["REALTIME"] }
output "api_id" { value = aws_appsync_graphql_api.main.id }
