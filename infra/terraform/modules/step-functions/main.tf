# =============================================================================
# Step Functions - the ingest state machine
# =============================================================================

variable "name_prefix" { type = string }
variable "env" { type = string }
variable "definition_path" { type = string }
variable "event_bus_name" { type = string }
variable "event_bus_arn" { type = string }
variable "lambda_arns" {
  description = "collect / normalise / resolve / evaluate / detect / publish function ARNs"
  type        = map(string)
}

resource "aws_cloudwatch_log_group" "sfn" {
  name              = "/aws/vendedlogs/states/${var.name_prefix}-ingest"
  retention_in_days = var.env == "prod" ? 90 : 14
}

resource "aws_sfn_state_machine" "ingest" {
  name     = "${var.name_prefix}-ingest"
  role_arn = aws_iam_role.sfn.arn

  # STANDARD, not EXPRESS.
  #   STANDARD - exactly-once, up to 1 year, full visual execution history,
  #              billed per state transition. Right for a scheduled ingest that
  #              runs every 5 minutes and that you will need to debug.
  #   EXPRESS  - at-least-once, max 5 minutes, billed per GB-second (far
  #              cheaper at very high volume), logs instead of history. Right
  #              for per-API-request orchestration.
  type = "STANDARD"

  # templatefile() injects the Lambda ARNs into the ASL placeholders, so the
  # definition file stays environment-agnostic and reviewable as pure JSON.
  definition = templatefile(var.definition_path, {
    collect_function_arn   = var.lambda_arns["collect"]
    normalise_function_arn = var.lambda_arns["normalise"]
    resolve_function_arn   = var.lambda_arns["resolve"]
    evaluate_function_arn  = var.lambda_arns["evaluate"]
    detect_function_arn    = var.lambda_arns["detect"]
    publish_function_arn   = var.lambda_arns["publish"]
    event_bus_name         = var.event_bus_name
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
    include_execution_data = var.env != "prod" # execution data can contain PII
    level                  = var.env == "prod" ? "ERROR" : "ALL"
  }

  tracing_configuration {
    enabled = true
  }

  tags = {
    Environment = var.env
  }
}

# -----------------------------------------------------------------------------
# Alarms
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "failed" {
  alarm_name          = "${var.name_prefix}-ingest-failed"
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    StateMachineArn = aws_sfn_state_machine.ingest.arn
  }
}

# A run that never STARTS is the failure mode nobody alarms on. If the schedule
# breaks, ExecutionsFailed stays at zero and everything looks fine while the
# data quietly goes stale. Alarm on the absence of executions too.
resource "aws_cloudwatch_metric_alarm" "not_running" {
  alarm_name          = "${var.name_prefix}-ingest-not-running"
  namespace           = "AWS/States"
  metric_name         = "ExecutionsStarted"
  statistic           = "Sum"
  period              = 1800
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching" # no data IS the alarm here

  dimensions = {
    StateMachineArn = aws_sfn_state_machine.ingest.arn
  }
}

# -----------------------------------------------------------------------------
# IAM
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${var.name_prefix}-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

resource "aws_iam_role_policy" "sfn" {
  name = "${var.name_prefix}-sfn"
  role = aws_iam_role.sfn.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        # Enumerated, not "*". A state machine that can invoke every Lambda in
        # the account is a lateral-movement path.
        Resource = concat(
          values(var.lambda_arns),
          [for arn in values(var.lambda_arns) : "${arn}:*"],
        )
      },
      {
        Effect   = "Allow"
        Action   = ["events:PutEvents"]
        Resource = [var.event_bus_arn]
      },
      {
        # Required for logging_configuration. These specific actions genuinely
        # do not support resource-level permissions - a rare legitimate "*".
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups",
        ]
        Resource = ["*"]
      },
      {
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules"]
        Resource = ["*"]
      },
    ]
  })
}

output "state_machine_arn" { value = aws_sfn_state_machine.ingest.arn }
