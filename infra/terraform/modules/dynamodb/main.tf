# =============================================================================
# DynamoDB - one table for every entity
# =============================================================================

variable "name_prefix" { type = string }
variable "env" { type = string }

resource "aws_dynamodb_table" "main" {
  name = "${var.name_prefix}-main"

  # PAY_PER_REQUEST for spiky, unpredictable SaaS traffic - you pay per request
  # and never think about capacity. Switch to PROVISIONED with autoscaling only
  # once traffic is steady enough to forecast; it is roughly 5x cheaper at high,
  # predictable volume, and considerably more expensive if you guess wrong.
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "PK"
  range_key = "SK"

  # Only KEY attributes are declared. DynamoDB is schemaless for everything
  # else - a very common misreading of this resource is that you must list
  # every field here. You must not.
  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  # GSI1 serves the "all readings for one driver, newest first" access pattern.
  #
  # A GSI is a full, eventually-consistent copy of the projected attributes,
  # with its own throughput. Two consequences worth stating out loud:
  #   - it costs write units on EVERY write to the base table;
  #   - it is SPARSE: items without GSI1PK simply do not appear in it, which is
  #     a useful trick for indexing only the subset you care about.
  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "INCLUDE"

    # Project only what the query needs. ALL doubles your storage and write
    # cost; KEYS_ONLY forces a second read per item. INCLUDE is usually right.
    non_key_attributes = [
      "telemetryId", "provider", "kind", "value", "unit", "severity", "observedAt", "driverId",
    ]
  }

  # Streams feed the transactional-outbox pattern: a Lambda on the stream
  # publishes to EventBridge, so "write the row" and "announce the row" cannot
  # diverge. This is the rigorous answer to exactly-once event publishing.
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  # Automatic expiry for raw telemetry. Set `expiresAt` (epoch seconds) on write
  # and DynamoDB deletes the item within ~48h, free. Far cheaper than a
  # scheduled cleanup job, and it keeps hot partitions small.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.env == "prod"
  }

  server_side_encryption {
    enabled = true # AWS-owned key; set kms_key_arn for a customer-managed key
  }

  deletion_protection_enabled = var.env == "prod"

  tags = {
    Environment = var.env
  }
}

# -----------------------------------------------------------------------------
# Tenant isolation at the IAM layer
# -----------------------------------------------------------------------------
# This policy document is what a Lambda assumes (via STS, with the tenantId
# templated in) so that AWS itself refuses a cross-tenant read - not just our
# application code. Belt and braces.

data "aws_iam_policy_document" "tenant_scoped_access" {
  statement {
    effect = "Allow"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:BatchWriteItem",
    ]

    resources = [
      aws_dynamodb_table.main.arn,
      "${aws_dynamodb_table.main.arn}/index/*",
    ]

    # The leading (partition) key must begin with this tenant's prefix.
    # $${...} escapes Terraform interpolation so the literal reaches IAM,
    # where STS substitutes the tag at assume-role time.
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["TENANT#$${aws:PrincipalTag/tenantId}#*"]
    }
  }
}

output "table_name" { value = aws_dynamodb_table.main.name }
output "table_arn" { value = aws_dynamodb_table.main.arn }
output "stream_arn" { value = aws_dynamodb_table.main.stream_arn }
output "tenant_scoped_policy_json" { value = data.aws_iam_policy_document.tenant_scoped_access.json }
