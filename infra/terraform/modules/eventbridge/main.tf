# =============================================================================
# EventBridge - custom bus, rules, schedules, DLQs
# =============================================================================

variable "name_prefix" { type = string }
variable "env" { type = string }
variable "ingest_state_machine_arn" { type = string }
variable "notifier_lambda_arn" { type = string }
variable "agent_lambda_arn" { type = string }

# A CUSTOM bus, not the account default bus. The default bus also receives
# every AWS service event in the account, so your rules end up filtering
# through noise you do not control, and you cannot cleanly manage access to it.
resource "aws_cloudwatch_event_bus" "main" {
  name = "${var.name_prefix}-bus"
}

# -----------------------------------------------------------------------------
# Dead-letter queue
# -----------------------------------------------------------------------------
# EventBridge retries a failing target for up to 24 hours, then DROPS the event
# silently unless a DLQ is attached. Attach one to every rule that matters.

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name_prefix}-events-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
  sqs_managed_sse_enabled   = true
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.name_prefix}-events-dlq-not-empty"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }
}

# -----------------------------------------------------------------------------
# Scheduled ingest
# -----------------------------------------------------------------------------
# EventBridge SCHEDULER (not the older `aws_cloudwatch_event_rule` with a cron
# expression). Scheduler is the current service: it supports one-off schedules,
# time zones with DST handling, and a flexible time window that JITTERS the
# start so a thousand tenants do not all fire at :00 and stampede the vendor.

resource "aws_scheduler_schedule" "ingest" {
  name       = "${var.name_prefix}-ingest"
  group_name = "default"

  schedule_expression          = "rate(5 minutes)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 2
  }

  target {
    arn      = var.ingest_state_machine_arn
    role_arn = aws_iam_role.scheduler.arn

    input = jsonencode({
      tenantId = "ALL"
      since    = "PT5M"
    })

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 300
    }

    dead_letter_config {
      arn = aws_sqs_queue.dlq.arn
    }
  }
}

# -----------------------------------------------------------------------------
# Rules
# -----------------------------------------------------------------------------

# Critical incidents page a human. The pattern filters on `severity` INSIDE the
# bus, so the notifier Lambda is never invoked for a warning - you do not pay
# to start a function that immediately decides the event was not for it.
resource "aws_cloudwatch_event_rule" "critical_incidents" {
  name           = "${var.name_prefix}-critical-incidents"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source        = ["meridian.detect", "meridian.api"]
    "detail-type" = ["IncidentOpened"]
    detail = {
      severity = ["critical"]
    }
  })
}

resource "aws_cloudwatch_event_target" "critical_to_notifier" {
  rule           = aws_cloudwatch_event_rule.critical_incidents.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  arn            = var.notifier_lambda_arn

  retry_policy {
    maximum_retry_attempts       = 3
    maximum_event_age_in_seconds = 3600
  }

  dead_letter_config {
    arn = aws_sqs_queue.dlq.arn
  }
}

# The same event ALSO triggers the AI agent to write a root-cause summary.
# Two independent consumers of one event, neither aware of the other - this is
# what "event-driven" buys you. Adding a third is a Terraform change only.
resource "aws_cloudwatch_event_target" "critical_to_agent" {
  rule           = aws_cloudwatch_event_rule.critical_incidents.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  arn            = var.agent_lambda_arn
  target_id      = "ai-summariser"

  # Reshape the event before it reaches the target, so the Lambda receives a
  # clean payload instead of the whole envelope.
  input_transformer {
    input_paths = {
      incidentId = "$.detail.incidentId"
      tenantId   = "$.detail.tenantId"
    }

    input_template = <<EOT
{
  "incidentId": "<incidentId>",
  "tenantId": "<tenantId>",
  "task": "summarise"
}
EOT
  }

  dead_letter_config {
    arn = aws_sqs_queue.dlq.arn
  }
}

# Archive every event for replay. An archive plus a replay is how you recover
# from "our consumer had a bug for six hours" without asking vendors for data.
resource "aws_cloudwatch_event_archive" "main" {
  name             = "${var.name_prefix}-archive"
  event_source_arn = aws_cloudwatch_event_bus.main.arn
  retention_days   = var.env == "prod" ? 90 : 7
}

# -----------------------------------------------------------------------------
# IAM
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name_prefix}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  name = "${var.name_prefix}-scheduler"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["states:StartExecution"]
        Resource = [var.ingest_state_machine_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [aws_sqs_queue.dlq.arn]
      },
    ]
  })
}

resource "aws_lambda_permission" "notifier" {
  statement_id  = "AllowEventBridgeInvokeNotifier"
  action        = "lambda:InvokeFunction"
  function_name = var.notifier_lambda_arn
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.critical_incidents.arn
}

resource "aws_lambda_permission" "agent" {
  statement_id  = "AllowEventBridgeInvokeAgent"
  action        = "lambda:InvokeFunction"
  function_name = var.agent_lambda_arn
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.critical_incidents.arn
}

output "bus_name" { value = aws_cloudwatch_event_bus.main.name }
output "bus_arn" { value = aws_cloudwatch_event_bus.main.arn }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
