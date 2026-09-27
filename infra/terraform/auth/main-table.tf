# =============================================================================
# The operational store: the platform's one DynamoDB table
# =============================================================================
# The single-table design documented in src/aws/dynamodb.ts - devices, alarms,
# incidents, comms counts, health, baselines - which the in-memory table
# stands in for offline. The platform talks to it through
# src/aws/dynamodb.sdk.ts, registered with setTableStore by Node entry points
# only; nothing the browser loads can reach it.
#
# WHY HERE, in the root that is applied, rather than modules/dynamodb: that
# module belongs to the full stack under envs/, which brings Aurora and
# Kinesis with it. This is the table alone, and it costs what it is used:
# on-demand, $1.25 per million writes and $0.25 per million reads, and 25 GB
# of storage free. A demo tenant polled every five minutes is cents a month.
#
# Different from modules/dynamodb in one way that matters: GSI1 projects ALL
# attributes. That module projects an INCLUDE list of observation fields, and
# devicesAtSite reads DEVICES through GSI1 - they would come back with their
# status and load missing, and nothing would error. The in-memory table
# returns whole items from its GSI, so ALL is also what keeps the two stores
# answering the same question the same way.

resource "aws_dynamodb_table" "main" {
  name         = "${local.name_prefix}-main"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

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

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  # Off outside prod, unlike the membership table. Everything in here is
  # DERIVED - rebuilt by the next poll from the vendors' own APIs - so a
  # restore is re-running the poll, and PITR would bill for storage twice.
  # The membership table is the opposite: nothing regenerates it.
  point_in_time_recovery {
    enabled = var.env == "prod"
  }

  server_side_encryption {
    enabled = true
  }

  # The MCP server's audit trail (src/ai/audit.ts) is the one thing in here
  # that should AGE OUT: every tool call the agent made, kept 90 days and
  # then deleted by DynamoDB for free. Items without `expiresAt` - everything
  # else - are never touched. TTL deletion is lazy (typically within days),
  # so readers filter on it too rather than trusting that expired rows are gone.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  deletion_protection_enabled = var.env == "prod"
}

output "main_table_name" {
  description = "TABLE_NAME for anything that should use the real table - `pnpm seed:aws`, the API Lambda."
  value       = aws_dynamodb_table.main.name
}
