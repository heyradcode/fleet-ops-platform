# =============================================================================
# test environment root
# =============================================================================
# Torn down and rebuilt by CI on every integration run. Nothing here is precious.
#
# This is the ENTIRE environment. There is no variables.tf and no
# terraform.tfvars, because a root module is the place where concrete values
# belong - routing them through `variable` + tfvars is an indirection that only
# earns its keep for values injected at apply time. Here that is two secrets,
# and nothing else.
#
# Why separate DIRECTORIES rather than Terraform workspaces: workspaces share
# one backend key and one provider config, so nothing stops a mis-set
# TF_WORKSPACE from pointing a destroy at prod. Separate directories, separate
# state files and separate AWS ACCOUNTS make that mistake impossible rather
# than merely discouraged.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }

  # The backend block is the one place Terraform allows no variables and no
  # interpolation at all, which is why these four lines are duplicated across
  # environments and cannot be factored out in plain Terraform. (Eliminating
  # exactly this residue is what Terragrunt's `generate` block is for, and the
  # only reason worth adopting it here.)
  backend "s3" {
    bucket       = "meridian-tfstate-222233334444"
    key          = "test/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true # Terraform 1.10+; replaced the DynamoDB lock table
  }
}

provider "aws" {
  region = "us-east-1"

  # CI assumes this role via GitHub OIDC. No long-lived AWS access keys exist
  # anywhere in this repo or in GitHub secrets.
  assume_role {
    role_arn = "arn:aws:iam::222233334444:role/meridian-deploy"
  }

  default_tags {
    tags = {
      Project     = "meridian"
      Environment = "test"
      ManagedBy   = "terraform"

      # Cost allocation tags are the only way to answer "what does the AI
      # feature actually cost us?" later. Add them on day one; retrofitting
      # them means losing the history you wanted.
      CostCenter = "platform"
    }
  }
}

module "stack" {
  source = "../../stack"

  env        = "test"
  aws_region = "us-east-1"
  app_origin = "https://test.meridian.example.com"

  # The only true variables. CI exports TF_VAR_google_client_id and
  # TF_VAR_google_client_secret, read from Secrets Manager at apply time.
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
}

# Declared here because a Terraform root cannot inherit variable declarations
# from the module it calls. Two is the irreducible minimum.
variable "google_client_id" {
  type      = string
  sensitive = true
}

variable "google_client_secret" {
  type      = string
  sensitive = true
}

output "graphql_endpoint" { value = module.stack.graphql_endpoint }
output "realtime_endpoint" { value = module.stack.realtime_endpoint }
output "rest_endpoint" { value = module.stack.rest_endpoint }
output "cognito_user_pool_id" { value = module.stack.cognito_user_pool_id }
output "cognito_client_id" { value = module.stack.cognito_client_id }
output "cognito_hosted_ui" { value = module.stack.cognito_hosted_ui }
output "state_machine_arn" { value = module.stack.state_machine_arn }
output "raw_bucket" { value = module.stack.raw_bucket }

# Consumed by the deploy pipeline for migrations and knowledge-base sync.
output "aurora_cluster_arn" { value = module.stack.aurora_cluster_arn }
output "aurora_secret_arn" { value = module.stack.aurora_secret_arn }
output "runbooks_bucket" { value = module.stack.runbooks_bucket }
output "knowledge_base_id" { value = module.stack.knowledge_base_id }
output "knowledge_base_data_source_id" { value = module.stack.knowledge_base_data_source_id }
