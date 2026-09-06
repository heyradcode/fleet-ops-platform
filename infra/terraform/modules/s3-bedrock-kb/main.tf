# =============================================================================
# S3 raw layer + Bedrock Knowledge Base
# =============================================================================

variable "name_prefix" { type = string }
variable "env" { type = string }
variable "embedding_model_arn" { type = string }

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# -----------------------------------------------------------------------------
# Raw landing zone
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "raw" {
  bucket = "${var.name_prefix}-raw-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "raw" {
  bucket                  = aws_s3_bucket.raw.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "raw" {
  bucket = aws_s3_bucket.raw.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    # Bucket keys cut KMS request costs by up to 99% on high-volume prefixes.
    # Free money; there is no reason not to set it.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id

  rule {
    id     = "tier-and-expire"
    status = "Enabled"

    filter {
      prefix = "raw/"
    }

    # Raw payloads are read constantly for the first week (replay, debugging),
    # then almost never. Glacier IR keeps millisecond retrieval at ~1/4 the
    # price of Standard.
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }

    expiration {
      days = var.env == "prod" ? 2555 : 30 # 7 years in prod for audit
    }

    # Versioning is on, so old versions accumulate invisibly. Without this rule
    # you pay for every overwrite forever. A very common surprise bill.
    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    # Multipart uploads that failed leave orphaned parts you are billed for and
    # cannot see in the console.
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# -----------------------------------------------------------------------------
# Knowledge base source bucket
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "runbooks" {
  bucket = "${var.name_prefix}-runbooks-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "runbooks" {
  bucket                  = aws_s3_bucket.runbooks.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# -----------------------------------------------------------------------------
# Bedrock Knowledge Base
# -----------------------------------------------------------------------------
# The vector store is OpenSearch Serverless here. Alternatives, and when:
#   Aurora pgvector  - you already run Aurora; cheapest at small scale, and it
#                      lets you JOIN embeddings against relational data.
#   OpenSearch Svls  - best hybrid (semantic + BM25) search; higher floor cost.
#   Pinecone/Redis   - managed third party; fine, but another vendor.
#
# The collection and index are omitted for brevity - see
# aws_opensearchserverless_collection and the vector index mapping.

resource "aws_bedrockagent_knowledge_base" "runbooks" {
  name     = "${var.name_prefix}-runbooks"
  role_arn = aws_iam_role.kb.arn

  knowledge_base_configuration {
    type = "VECTOR"

    vector_knowledge_base_configuration {
      embedding_model_arn = var.embedding_model_arn
    }
  }

  storage_configuration {
    type = "OPENSEARCH_SERVERLESS"

    opensearch_serverless_configuration {
      collection_arn    = "arn:aws:aoss:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:collection/REPLACE_ME"
      vector_index_name = "netpulse-runbooks"

      field_mapping {
        vector_field   = "embedding"
        text_field     = "text"
        # THE field that makes multi-tenant RAG safe. Retrieval requests pass a
        # filter on metadata, so tenant A cannot retrieve tenant B's documents.
        # Without it, a knowledge base is a cross-tenant data leak waiting to
        # happen - the RAG equivalent of a missing WHERE clause.
        metadata_field = "metadata"
      }
    }
  }
}

resource "aws_bedrockagent_data_source" "runbooks" {
  knowledge_base_id = aws_bedrockagent_knowledge_base.runbooks.id
  name              = "${var.name_prefix}-runbooks-s3"

  data_source_configuration {
    type = "S3"

    s3_configuration {
      bucket_arn = aws_s3_bucket.runbooks.arn
    }
  }

  vector_ingestion_configuration {
    chunking_configuration {
      # HIERARCHICAL respects document structure (headings), which is right for
      # runbooks. FIXED_SIZE with overlap is right for unstructured prose.
      # SEMANTIC splits on embedding similarity - best quality, most expensive
      # to ingest. Chunking strategy is the single biggest quality lever in RAG.
      chunking_strategy = "HIERARCHICAL"

      hierarchical_chunking_configuration {
        overlap_tokens = 60

        level_configuration {
          max_tokens = 1500 # parent: returned to the model for context
        }

        level_configuration {
          max_tokens = 300 # child: what actually gets embedded and matched
        }
      }
    }
  }
}

# -----------------------------------------------------------------------------
# Guardrail
# -----------------------------------------------------------------------------

resource "aws_bedrock_guardrail" "main" {
  name                      = "${var.name_prefix}-guardrail"
  blocked_input_messaging   = "That request is outside what this assistant can help with."
  blocked_outputs_messaging = "I could not produce an answer I can stand behind."

  content_policy_config {
    filters_config {
      type            = "PROMPT_ATTACK"
      input_strength  = "HIGH"
      output_strength = "NONE" # prompt attacks are an input-side concern
    }

    filters_config {
      type            = "HATE"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
  }

  sensitive_information_policy_config {
    # ANONYMIZE, not BLOCK: an operator legitimately needs to discuss a device
    # by IP. Blocking would make the assistant useless; masking in the stored
    # transcript keeps it safe.
    pii_entities_config {
      type   = "EMAIL"
      action = "ANONYMIZE"
    }

    pii_entities_config {
      type   = "CREDIT_DEBIT_CARD_NUMBER"
      action = "BLOCK"
    }
  }

  # Contextual grounding is the closest thing to a managed hallucination check:
  # it scores the answer against the retrieved passages and blocks it below the
  # threshold. Essential when the agent's output drives operational decisions.
  contextual_grounding_policy_config {
    filters_config {
      type      = "GROUNDING"
      threshold = 0.75
    }

    filters_config {
      type      = "RELEVANCE"
      threshold = 0.7
    }
  }
}

# -----------------------------------------------------------------------------
# IAM
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "kb_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }

    # Confused-deputy protection: this role may only be assumed on behalf of
    # OUR account. Without it, another customer's Bedrock could in principle
    # be pointed at this role.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "kb" {
  name               = "${var.name_prefix}-bedrock-kb"
  assume_role_policy = data.aws_iam_policy_document.kb_assume.json
}

resource "aws_iam_role_policy" "kb" {
  name = "${var.name_prefix}-bedrock-kb"
  role = aws_iam_role.kb.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.runbooks.arn, "${aws_s3_bucket.runbooks.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = [var.embedding_model_arn]
      },
    ]
  })
}

output "raw_bucket" { value = aws_s3_bucket.raw.bucket }
output "raw_bucket_arn" { value = aws_s3_bucket.raw.arn }
output "runbooks_bucket" { value = aws_s3_bucket.runbooks.bucket }
output "knowledge_base_id" { value = aws_bedrockagent_knowledge_base.runbooks.id }
output "guardrail_id" { value = aws_bedrock_guardrail.main.guardrail_id }
output "knowledge_base_data_source_id" { value = aws_bedrockagent_data_source.runbooks.data_source_id }
