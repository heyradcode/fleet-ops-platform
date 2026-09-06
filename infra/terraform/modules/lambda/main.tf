# =============================================================================
# Reusable Lambda module
# =============================================================================
# Every function in the platform is created through this module, so the whole
# fleet gets the same logging retention, the same tracing, the same alarms and
# the same least-privilege posture without anyone having to remember.

variable "name" { type = string }
variable "env" { type = string }
variable "handler" { type = string }
variable "source_dir" { type = string }
variable "memory_mb" {
  type    = number
  default = 512
}
variable "timeout_seconds" {
  type    = number
  default = 30
}
variable "environment" {
  type    = map(string)
  default = {}
}
variable "policy_statements" {
  description = "Extra IAM statements this function needs, beyond logging."
  type = list(object({
    actions   = list(string)
    resources = list(string)
  }))
  default = []
}
variable "provisioned_concurrency" {
  type    = number
  default = 0
}
variable "reserved_concurrency" {
  description = "Caps this function's share of the account concurrency pool. -1 means uncapped."
  type        = number
  default     = -1
}

data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# Packaging
# -----------------------------------------------------------------------------
# archive_file is fine for a demo. Real pipelines build with esbuild and either
# push a zip to S3 or a container image to ECR, so that the artefact is built
# once in CI and the exact same bytes are promoted dev -> test -> stage -> prod.

data "archive_file" "package" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.module}/.build/${var.name}.zip"
}

# -----------------------------------------------------------------------------
# Execution role
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "${var.name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "inline" {
  # Scoped to THIS function's log group, not "*". The managed
  # AWSLambdaBasicExecutionRole policy grants logs:* on all log groups, which
  # is more than any single function needs.
  statement {
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.this.arn}:*",
    ]
  }

  statement {
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"] # X-Ray does not support resource-level permissions
  }

  dynamic "statement" {
    for_each = var.policy_statements

    content {
      effect    = "Allow"
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role_policy" "inline" {
  name   = "${var.name}-inline"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.inline.json
}

# -----------------------------------------------------------------------------
# Log group, created explicitly
# -----------------------------------------------------------------------------
# If you let Lambda create it implicitly you get NEVER-EXPIRE retention and an
# unbounded CloudWatch bill. Creating it here is one of the highest-value
# three-line changes in any AWS account.

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.env == "prod" ? 90 : 14
}

# -----------------------------------------------------------------------------
# The function
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "this" {
  function_name = var.name
  role          = aws_iam_role.this.arn
  handler       = var.handler
  runtime       = "nodejs22.x"
  architectures = ["arm64"] # Graviton: ~20% cheaper and usually faster

  filename         = data.archive_file.package.output_path
  source_code_hash = data.archive_file.package.output_base64sha256

  memory_size = var.memory_mb
  timeout     = var.timeout_seconds

  # Memory is the only performance dial on Lambda - CPU scales with it. A
  # function that runs twice as fast at 1024MB than at 512MB costs the SAME,
  # because you are billed for GB-seconds. Tune with AWS Lambda Power Tuning
  # rather than guessing; the cheapest setting is rarely the smallest.

  reserved_concurrent_executions = var.reserved_concurrency

  tracing_config {
    mode = "Active" # X-Ray, so you can see the whole request across services
  }

  environment {
    variables = merge(var.environment, {
      NODE_OPTIONS = "--enable-source-maps"
      LOG_FORMAT   = "json"
      ENV          = var.env
    })
  }

  depends_on = [aws_cloudwatch_log_group.this]
}

# Publishing a version + alias is what makes gradual deployment possible.
resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.this.function_name
  function_version = aws_lambda_function.this.version
}

# Provisioned concurrency removes cold starts, at a price. Only worth it on
# user-facing, latency-sensitive paths - the authorizer and the GraphQL
# resolver. Never on the batch ingest pipeline.
resource "aws_lambda_provisioned_concurrency_config" "this" {
  count = var.provisioned_concurrency > 0 ? 1 : 0

  function_name                     = aws_lambda_function.this.function_name
  qualifier                         = aws_lambda_alias.live.name
  provisioned_concurrent_executions = var.provisioned_concurrency
}

# -----------------------------------------------------------------------------
# Alarms every function gets for free
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${var.name}-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.this.function_name
  }
}

# Throttles mean you have hit a concurrency limit - a different problem from
# errors, needing a different fix, so it gets its own alarm.
resource "aws_cloudwatch_metric_alarm" "throttles" {
  alarm_name          = "${var.name}-throttles"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.this.function_name
  }
}

output "arn" { value = aws_lambda_function.this.arn }
output "alias_arn" { value = aws_lambda_alias.live.arn }
output "name" { value = aws_lambda_function.this.function_name }
output "role_arn" { value = aws_iam_role.this.arn }
output "role_name" { value = aws_iam_role.this.name }
