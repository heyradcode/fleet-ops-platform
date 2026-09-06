# =============================================================================
# Kinesis Data Firehose - the cold path
# =============================================================================
# The other half of the hot/cold split:
#
#   hot   DynamoDB   one item per driver, OVERWRITTEN    330k items, always
#   cold  S3         append-only, Parquet                ~950M rows/day
#
# Firehose exists here to do three things that a naive "write each record to
# S3" would get wrong:
#
#   1. BUFFER. One object per record would mean ~950 million PUTs a day - more
#      expensive in requests than in storage - and Athena would spend its life
#      opening files rather than reading them.
#   2. CONVERT to Parquet. Columnar means a query for "speed on route X" reads
#      one column, not every byte of every row. Typically 10x less scanned, and
#      Athena bills on bytes scanned.
#   3. PARTITION by date and hour, so a query for last Tuesday prunes to one
#      day's prefixes instead of scanning the lake.

variable "name" { type = string }
variable "tags" { type = map(string) }
variable "source_stream_arn" { type = string }
variable "history_bucket_arn" { type = string }
variable "glue_table_arn" { type = string }
variable "role_arn" { type = string }

resource "aws_kinesis_firehose_delivery_stream" "history" {
  name        = "${var.name}-telemetry-history"
  destination = "extended_s3"

  kinesis_source_configuration {
    kinesis_stream_arn = var.source_stream_arn
    role_arn           = var.role_arn
  }

  extended_s3_configuration {
    role_arn   = var.role_arn
    bucket_arn = var.history_bucket_arn

    # Hive-style partitioning. `dt=` and `hh=` are what let Athena prune - a
    # query with `WHERE dt = '2026-09-08'` reads one prefix rather than the
    # whole bucket. Getting this wrong is the difference between a 2-second
    # query and a 200-second one on identical data.
    prefix              = "telemetry/dt=!{timestamp:yyyy-MM-dd}/hh=!{timestamp:HH}/"
    error_output_prefix = "errors/!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/"

    # Buffer until 128MB or 300s, whichever comes first. Bigger buffers make
    # better Parquet files and cheaper queries; they also delay availability,
    # so this is a freshness-versus-cost dial. History is read by analysts and
    # safety reviewers, not by the live board, so five minutes is generous.
    buffering_size     = 128
    buffering_interval = 300

    compression_format = "UNCOMPRESSED" # Parquet carries its own compression

    data_format_conversion_configuration {
      enabled = true

      input_format_configuration {
        deserializer { open_x_json_ser_de {} }
      }

      output_format_configuration {
        serializer {
          parquet_ser_de {
            compression = "SNAPPY"
          }
        }
      }

      # The schema Firehose converts against. A Glue table, so Athena and
      # Firehose cannot disagree about the shape of the data.
      schema_configuration {
        role_arn      = var.role_arn
        database_name = "meridian"
        table_name    = "telemetry_history"
      }
    }

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = "/aws/kinesisfirehose/${var.name}-telemetry-history"
      log_stream_name = "S3Delivery"
    }
  }

  tags = var.tags
}

# ---------------------------------------------------------------------------
# Lifecycle: history is an asset AND a liability
# ---------------------------------------------------------------------------
# Position history is simultaneously an analytics asset, a safety-review asset,
# and a record of where identifiable people were at identifiable times. The
# retention answer is legal before it is technical, and this policy is a
# placeholder for a decision the business has to make - not a default to accept
# without asking.
resource "aws_s3_bucket_lifecycle_configuration" "history" {
  bucket = replace(var.history_bucket_arn, "arn:aws:s3:::", "")

  rule {
    id     = "tier-then-expire"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "INTELLIGENT_TIERING"
    }

    transition {
      days          = 180
      storage_class = "GLACIER_IR"
    }

    # DECIDE THIS DELIBERATELY. Two years is a common answer for safety review;
    # your jurisdiction, your insurer and your works council may all disagree.
    expiration {
      days = 730
    }
  }
}

output "delivery_stream_arn" { value = aws_kinesis_firehose_delivery_stream.history.arn }
