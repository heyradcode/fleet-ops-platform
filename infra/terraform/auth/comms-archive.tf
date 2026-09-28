# =============================================================================
# The comms archive: each poll's normalised output, as a backup in S3
# =============================================================================
# What src/integrations/comms/archive.ts writes after every Teams / Webex /
# Genesys poll: the signals, alarms, incidents, workforce COUNTS and health -
# never people (the archive refuses to write an email address or a phone
# number, and has no field for the roster). JSON Lines, hive-partitioned:
#   comms/<record>/tenant=<t>/dt=YYYY-MM-DD/hh=HH/<poll time>.jsonl
# so Athena can query a year of it by partition, and the comms side of the
# main table can be rebuilt from it.
#
# In this root because it holds the operational data's backup, and this is
# the root that owns the operational data. `pnpm seed:aws` writes to it with
# the caller's own credentials (seed-policy.json); a scheduled poller would
# get PutObject on `comms/*` and nothing else.
#
# COST: one poll is five small objects - at a five-minute schedule, ~43,000
# PUTs a month (~$0.22) and a few MB. STANDARD storage only, deliberately:
# Standard-IA and the Glacier classes bill a MINIMUM object size (128 KB for
# IA and Glacier Instant Retrieval), and these objects are a few KB - a
# "cheaper" class would bill each one at thirty times its size.

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "comms_archive" {
  bucket = "${local.name_prefix}-comms-archive-${data.aws_caller_identity.current.account_id}"
  # NOT force_destroy: this is a backup. A `terraform destroy` that could
  # silently empty it would make it the one copy that disappears with the
  # thing it backs up. Empty it deliberately first if you mean it.
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "comms_archive" {
  bucket                  = aws_s3_bucket.comms_archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "comms_archive" {
  bucket = aws_s3_bucket.comms_archive.id
  rule {
    object_ownership = "BucketOwnerEnforced" # no ACLs, ever
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "comms_archive" {
  bucket = aws_s3_bucket.comms_archive.id
  rule {
    # SSE-S3: counts and rates, no personal data. A customer-managed KMS key
    # is $1/month plus a request charge per object, for no extra protection
    # of what is in here.
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Versioned: re-archiving a poll overwrites its keys, and a backup must not
# lose the version it replaced - or survive a mistaken delete with nothing.
resource "aws_s3_bucket_versioning" "comms_archive" {
  bucket = aws_s3_bucket.comms_archive.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "comms_archive" {
  bucket = aws_s3_bucket.comms_archive.id

  rule {
    id     = "retention"
    status = "Enabled"
    filter { prefix = "comms/" }

    # A year and a bit by default: long enough for year-on-year comparison.
    expiration { days = var.comms_archive_retention_days }
    # Replaced versions are a safety net, not a second archive.
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }

  depends_on = [aws_s3_bucket_versioning.comms_archive]
}

# TLS or nothing.
data "aws_iam_policy_document" "comms_archive" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.comms_archive.arn,
      "${aws_s3_bucket.comms_archive.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "comms_archive" {
  bucket = aws_s3_bucket.comms_archive.id
  policy = data.aws_iam_policy_document.comms_archive.json
  # The public-access block first, or the policy write can race it.
  depends_on = [aws_s3_bucket_public_access_block.comms_archive]
}

output "comms_archive_bucket" {
  description = "COMMS_ARCHIVE_BUCKET for pnpm seed:aws - where each comms poll's normalised output is backed up."
  value       = aws_s3_bucket.comms_archive.bucket
}
