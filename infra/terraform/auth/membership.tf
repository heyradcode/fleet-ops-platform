# =============================================================================
# Tenant membership: which carrier an email domain belongs to
# =============================================================================
# The table the PreTokenGeneration trigger reads on every login. Before this it
# was four literals compiled into the Lambda bundle, so onboarding a carrier
# meant a code change, a rebuild and a deploy - which is why a typo like
# meridian.com against meridian.io could not be fixed without a release.
#
# On-demand billing, because the access pattern is one tiny read per login and
# provisioned capacity would mean guessing a number and paying for it whether
# anyone signs in or not. Four rows of a few hundred bytes: this is free in
# practice, and about $0.125 per million reads if it ever is not.

resource "aws_dynamodb_table" "membership" {
  name         = "${local.name_prefix}-membership"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"

  attribute {
    name = "PK"
    type = "S"
  }

  # This table decides who can see whose fleet. Losing it is a full outage of
  # sign-in, and restoring it from a bundle rebuild is not a recovery plan.
  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  # A carrier removed by accident should be recoverable, and the table is
  # small enough that keeping it costs nothing.
  deletion_protection_enabled = var.env == "prod"
}

# -----------------------------------------------------------------------------
# The seed carriers
# -----------------------------------------------------------------------------
# The same four in DEMO_MEMBERSHIPS in src/platform/membership.ts, which is
# what the offline board and the tests read. Two hand-maintained copies would
# drift - a tenant rename has already caught this repository out once - so
# these are written from the shape that file documents, and the trigger test
# asserts the built-in path still returns them.
#
# aws_dynamodb_table_item manages ONE item and ignores others, so rows added
# through the console or an onboarding flow are left alone rather than
# destroyed on the next apply. That is the property that makes seeding safe
# here; it would not be true of a whole-table resource.

resource "aws_dynamodb_table_item" "membership" {
  for_each = {
    "acme-freight.com" = {
      tenantId = "acme-freight"
      roles    = ["dispatcher"]
      district = "dal"
    }
    "safety.acme-freight.com" = {
      tenantId = "acme-freight"
      roles    = ["safety"]
      district = null
    }
    "northstar-logistics.com" = {
      tenantId = "northstar-logistics"
      roles    = ["viewer"]
      district = null
    }
    "meridian.io" = {
      tenantId = "acme-freight"
      roles    = ["admin"]
      district = null
    }
  }

  table_name = aws_dynamodb_table.membership.name
  hash_key   = aws_dynamodb_table.membership.hash_key

  item = jsonencode(merge(
    {
      PK       = { S = "TENANT_MEMBERSHIP#${each.key}" }
      tenantId = { S = each.value.tenantId }
      # A string SET, not a list: roles are unordered and unique, and SS is
      # what membership.dynamodb.ts reads back.
      roles = { SS = each.value.roles }
    },
    # Absent district means tenant-wide. Writing an empty string instead would
    # give them a district called "", which scopeFromClaims would treat as no
    # district anyway - but only by accident. Omit the attribute.
    each.value.district == null ? {} : { district = { S = each.value.district } },
  ))
}
