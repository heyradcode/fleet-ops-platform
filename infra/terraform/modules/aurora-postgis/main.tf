# =============================================================================
# Aurora PostgreSQL Serverless v2 + PostGIS
# =============================================================================
# Why a relational database at all in a serverless stack? Because DynamoDB
# cannot answer "which drivers are within 75km of this point". Spatial indexes,
# ad-hoc joins and aggregate reporting are exactly what Postgres is for.
#
#   DynamoDB - hot, high-volume, known-key reads (driver position, telemetry)
#   Aurora   - reference data, spatial queries, analytics

variable "name_prefix" { type = string }
variable "env" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "lambda_security_group_id" { type = string }

resource "aws_db_subnet_group" "main" {
  name       = "${var.name_prefix}-aurora"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "aurora" {
  name   = "${var.name_prefix}-aurora"
  vpc_id = var.vpc_id

  # Ingress from the Lambda security group only - never a CIDR, and never
  # 0.0.0.0/0. Referencing the SG means the rule keeps working as subnets
  # change and it documents WHO is allowed, not just from where.
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.lambda_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Credentials are generated and rotated by Secrets Manager. Nobody ever sees
# this password, and it is never in Terraform state as plaintext input.
resource "aws_rds_cluster" "main" {
  cluster_identifier = "${var.name_prefix}-aurora"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned" # required for Serverless v2
  engine_version     = "16.4"
  database_name      = "meridian"

  master_username                     = "meridian_admin"
  manage_master_user_password         = true
  iam_database_authentication_enabled = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.aurora.id]

  # The Data API: HTTP access to Aurora with IAM auth and NO connection pool.
  # This is what makes Aurora usable from Lambda without RDS Proxy - each
  # invocation makes an HTTPS call instead of opening a Postgres connection.
  # Slightly higher per-query latency; vastly simpler operationally.
  enable_http_endpoint = true

  serverlessv2_scaling_configuration {
    min_capacity = var.env == "prod" ? 1.0 : 0.5
    max_capacity = var.env == "prod" ? 16.0 : 2.0

    # Scale to ZERO after 15 minutes idle. In a dev environment this takes the
    # database bill to about nothing overnight. Cold resume costs ~15 seconds,
    # so never enable it in prod.
    seconds_until_auto_pause = var.env == "prod" ? null : 900
  }

  storage_encrypted               = true
  backup_retention_period         = var.env == "prod" ? 30 : 1
  preferred_backup_window         = "03:00-04:00"
  deletion_protection             = var.env == "prod"
  skip_final_snapshot             = var.env != "prod"
  final_snapshot_identifier       = var.env == "prod" ? "${var.name_prefix}-final" : null
  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = {
    Environment = var.env
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${var.name_prefix}-aurora-writer"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version

  performance_insights_enabled = var.env == "prod"
}

# A reader in prod so reporting queries cannot slow down writes.
resource "aws_rds_cluster_instance" "reader" {
  count = var.env == "prod" ? 1 : 0

  identifier                   = "${var.name_prefix}-aurora-reader"
  cluster_identifier           = aws_rds_cluster.main.id
  instance_class               = "db.serverless"
  engine                       = aws_rds_cluster.main.engine
  engine_version               = aws_rds_cluster.main.engine_version
  promotion_tier               = 1
  performance_insights_enabled = true
}

# -----------------------------------------------------------------------------
# Least-privilege data access for Lambda
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "data_api" {
  statement {
    actions = [
      "rds-data:ExecuteStatement",
      "rds-data:BatchExecuteStatement",
      "rds-data:BeginTransaction",
      "rds-data:CommitTransaction",
      "rds-data:RollbackTransaction",
    ]
    resources = [aws_rds_cluster.main.arn]
  }

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_rds_cluster.main.master_user_secret[0].secret_arn]
  }
}

output "cluster_arn" { value = aws_rds_cluster.main.arn }
output "cluster_endpoint" { value = aws_rds_cluster.main.endpoint }
output "reader_endpoint" { value = aws_rds_cluster.main.reader_endpoint }
output "secret_arn" { value = aws_rds_cluster.main.master_user_secret[0].secret_arn }
output "security_group_id" { value = aws_security_group.aurora.id }
output "data_api_policy_json" { value = data.aws_iam_policy_document.data_api.json }

# NOTE: `CREATE EXTENSION postgis;` cannot be done by Terraform - it is a SQL
# statement, not a resource. Run src/data/schema.sql as a migration step in the
# deploy pipeline (see .github/workflows/deploy.yml), which is where schema
# changes belong anyway so they can be reviewed and rolled back independently.
