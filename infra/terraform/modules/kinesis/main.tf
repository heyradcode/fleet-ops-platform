# =============================================================================
# Kinesis Data Streams - telemetry ingest
# =============================================================================
# The stream that makes the fleet numbers work:
#
#   330,000 drivers / one ping per 30s  ~=  11,000 records/sec sustained
#                                            ~950 million/day
#   peak (shift change, wave dispatch)   ~=  3-5x that
#
# Everything below follows from that arithmetic. See src/aws/kinesis.ts for the
# runnable model of the same behaviour.

variable "name" { type = string }
variable "env" { type = string }
variable "tags" { type = map(string) }

variable "consumer_function_arn" {
  type        = string
  description = "The batched consumer Lambda the event-source mapping invokes"
}

variable "on_failure_arn" {
  type        = string
  description = "SQS queue for records that fail even in isolation"
}

# ON-DEMAND vs PROVISIONED, and it is a real decision rather than a default:
#
#   ON_DEMAND    scales shards automatically, ~$0.04/hr base plus per-GB. No
#                capacity planning, but you pay the base whether or not traffic
#                is flowing, and it doubles capacity at most every 15 minutes -
#                which a shift-change spike can outrun.
#   PROVISIONED  $0.015/shard-hr, 1MB/s and 1000 records/s per shard. Cheaper
#                at steady high volume and instantly predictable, but you own
#                the resharding.
#
# Fleet telemetry is steady and predictable by nature - drivers work shifts, not
# flash sales - so provisioned wins on cost above a few thousand records/sec.
# Dev stays on-demand because dev traffic is neither steady nor high.
resource "aws_kinesis_stream" "telemetry" {
  name = "${var.name}-telemetry"

  stream_mode_details {
    stream_mode = var.env == "prod" ? "PROVISIONED" : "ON_DEMAND"
  }

  # 11,000 records/sec / 1,000 per shard = 11 shards minimum; 16 leaves room
  # for the shift-change peak without resharding under load.
  shard_count = var.env == "prod" ? 16 : null

  # 24h is the default and is not enough. Retention is your REPLAY WINDOW: if a
  # consumer bug is found on Friday evening, 24 hours means the weekend's data
  # is gone before anyone fixes it. Seven days costs little and has saved more
  # incidents than it has cost.
  retention_period = 168

  encryption_type = "KMS"
  kms_key_id      = "alias/aws/kinesis"

  shard_level_metrics = [
    "IncomingRecords",
    "OutgoingRecords",
    # The one that actually matters. See the alarm below.
    "IteratorAgeMilliseconds",
  ]

  tags = var.tags
}

# ---------------------------------------------------------------------------
# The event-source mapping - where the batching actually happens
# ---------------------------------------------------------------------------
resource "aws_lambda_event_source_mapping" "telemetry" {
  event_source_arn  = aws_kinesis_stream.telemetry.arn
  function_name     = var.consumer_function_arn
  starting_position = "TRIM_HORIZON"

  # THE SINGLE BIGGEST COST LEVER IN THE STACK. At 11,000 records/sec, a batch
  # size of 500 is ~22 invocations/sec instead of 11,000.
  batch_size = 500

  # ...and the latency knob that pairs with it. Wait up to 5s to fill a batch
  # rather than invoking half-empty. Raising this trades freshness for cost;
  # for position data that a human reads, 5s is invisible.
  maximum_batching_window_in_seconds = 5

  # More concurrent invocations per shard without adding shards. Safe here
  # because ordering only matters per driver, and a driver's records share a
  # partition key - they stay in order within their own sequence.
  parallelization_factor = 4

  # THE ONE PEOPLE FORGET, and the cause of the classic Kinesis outage: without
  # it, a single unparseable record fails its batch, the batch retries forever,
  # the shard stops advancing, and the backlog grows silently until somebody
  # notices the iterator-age metric. With it, the batch is split and the poison
  # record is isolated in ~log2(500) extra invocations.
  bisect_batch_on_function_error = true
  maximum_retry_attempts         = 3
  maximum_record_age_in_seconds  = 3600

  # The handler reports WHICH records failed rather than failing the whole
  # batch, so 499 good records are not reprocessed because of one bad one.
  function_response_types = ["ReportBatchItemFailures"]

  destination_config {
    on_failure {
      destination_arn = var.on_failure_arn
    }
  }
}

# ---------------------------------------------------------------------------
# The alarm that matters
# ---------------------------------------------------------------------------
# Iterator age is how far behind the consumer is. It is the ONLY metric that
# catches a stalled shard, and it is the difference between noticing in five
# minutes and noticing when a dispatcher asks why the board is frozen.
resource "aws_cloudwatch_metric_alarm" "iterator_age" {
  alarm_name          = "${var.name}-telemetry-iterator-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "GetRecords.IteratorAgeMilliseconds"
  namespace           = "AWS/Kinesis"
  period              = 60
  statistic           = "Maximum"
  threshold           = 60000 # one minute behind
  treat_missing_data  = "breaching"

  dimensions = {
    StreamName = aws_kinesis_stream.telemetry.name
  }

  tags = var.tags
}

output "stream_arn" { value = aws_kinesis_stream.telemetry.arn }
output "stream_name" { value = aws_kinesis_stream.telemetry.name }
