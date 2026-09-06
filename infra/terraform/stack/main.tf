data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# Network discovery
# -----------------------------------------------------------------------------
# The VPC is NOT created here. Networking is almost always a separate,
# longer-lived stack owned by a platform team - it outlives any one application
# and you do not want an application `destroy` anywhere near it.
#
# So we DISCOVER it by tag rather than accept three more ids as variables. That
# removes vpc_id, private_subnet_ids and lambda_security_group_id from every
# environment root, which is three lines of boilerplate × four environments ×
# two files each.
#
# The trade-off is an implicit contract: the network stack must tag things this
# way. State that contract loudly (here, and in the network stack's README) or
# it becomes a 20-minute debugging session for whoever adds environment five.
#
# The alternative, and the better choice once you have more than a couple of
# cross-stack references, is `terraform_remote_state` against the network
# stack's outputs - explicit and versioned, at the cost of granting read access
# to that state file.

data "aws_vpc" "main" {
  tags = {
    Name = "netpulse-${var.env}"
  }
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }

  tags = {
    Tier = "private"
  }
}

# The Lambda security group belongs to THIS stack, not the network stack: it is
# application-scoped, it changes when the application changes, and Aurora's
# ingress rule references it. Creating it here also means the "which SG may
# reach the database" question has exactly one answer, in one file.
resource "aws_security_group" "lambda" {
  name        = "netpulse-${var.env}-lambda"
  description = "Lambdas that need VPC access (Aurora only)"
  vpc_id      = data.aws_vpc.main.id

  # No ingress. Nothing connects TO a Lambda.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Environment = var.env
  }
}

locals {
  name_prefix = "netpulse-${var.env}"
  src_root    = "${path.module}/../../../src"

  # ---------------------------------------------------------------------------
  # DERIVED front-end URLs
  # ---------------------------------------------------------------------------
  # These were three separate variables that always moved together. One origin
  # in, three lists out - and no way for an environment to end up with a CORS
  # allow-list that disagrees with its Cognito callback URL, which is a genuinely
  # annoying afternoon.
  callback_urls = concat(["${var.app_origin}/auth/callback"], var.extra_callback_urls)
  logout_urls   = ["${var.app_origin}/"]
  cors_origins  = [var.app_origin]

  # ---------------------------------------------------------------------------
  # BREAKING A DEPENDENCY CYCLE
  # ---------------------------------------------------------------------------
  # The event bus and the state machine reference each other:
  #   eventbridge   needs the state machine ARN (the schedule targets it)
  #   step_functions needs the bus ARN         (the failure path publishes to it)
  # and the pipeline Lambdas need the bus while the bus targets a Lambda.
  #
  # Terraform resolves dependencies from the graph of references, so wiring
  # both directions through module outputs is a literal cycle and `plan` fails
  # with "Cycle: module.eventbridge -> module.step_functions -> ...".
  #
  # The fix is to construct the name/ARN of ONE side from known values instead
  # of reading it back out of the module. Bus names are deterministic, so this
  # costs nothing and is the standard way out. The alternative - splitting into
  # two states and using a remote-state data source - is worse: you get two
  # applies and a partially-deployed window between them.
  event_bus_name = "${local.name_prefix}-bus"
  event_bus_arn  = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:event-bus/${local.name_prefix}-bus"
}

# -----------------------------------------------------------------------------
# Data stores
# -----------------------------------------------------------------------------

module "dynamodb" {
  source      = "../../modules/dynamodb"
  name_prefix = local.name_prefix
  env         = var.env
}

module "storage" {
  source              = "../../modules/s3-bedrock-kb"
  name_prefix         = local.name_prefix
  env                 = var.env
  embedding_model_arn = "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.titan-embed-text-v2:0"
}

module "aurora" {
  source                   = "../../modules/aurora-postgis"
  name_prefix              = local.name_prefix
  env                      = var.env
  vpc_id                   = data.aws_vpc.main.id
  subnet_ids               = data.aws_subnets.private.ids
  lambda_security_group_id = aws_security_group.lambda.id
}

# -----------------------------------------------------------------------------
# Lambdas
# -----------------------------------------------------------------------------
# Each function gets ONLY the permissions it needs. Note how different they
# are - that difference is the entire point of not using one shared role.

module "lambda_pre_token" {
  source     = "../../modules/lambda"
  name       = "${local.name_prefix}-pre-token"
  env        = var.env
  handler    = "auth/pre-token-generation.handler"
  source_dir = local.src_root
  memory_mb  = 256

  # On the critical path of every single login. Keep it warm.
  provisioned_concurrency = var.env == "prod" ? 2 : 0

  environment = {
    TABLE_NAME = module.dynamodb.table_name
  }

  policy_statements = [{
    actions   = ["dynamodb:GetItem"]
    resources = [module.dynamodb.table_arn]
  }]
}

module "lambda_authorizer" {
  source     = "../../modules/lambda"
  name       = "${local.name_prefix}-authorizer"
  env        = var.env
  handler    = "auth/authorizer.handler"
  source_dir = local.src_root
  memory_mb  = 256

  environment = {
    COGNITO_USER_POOL_ID  = module.cognito.user_pool_id
    COGNITO_APP_CLIENT_ID = module.cognito.client_id
    COGNITO_ISSUER        = module.cognito.issuer
  }

  # No policy statements at all: verifying a JWT needs the public JWKS, which
  # is an unauthenticated HTTPS fetch. A function with no AWS permissions is
  # the ideal, and worth pointing out when someone asks about least privilege.
  policy_statements = []
}

module "lambda_graphql" {
  source          = "../../modules/lambda"
  name            = "${local.name_prefix}-graphql"
  env             = var.env
  handler         = "api/appsync-resolvers.handler"
  source_dir      = local.src_root
  memory_mb       = 1024
  timeout_seconds = 29 # must stay under AppSync's 30s ceiling

  environment = {
    TABLE_NAME                = module.dynamodb.table_name
    AURORA_CLUSTER_ARN        = module.aurora.cluster_arn
    AURORA_SECRET_ARN         = module.aurora.secret_arn
    BEDROCK_TEXT_MODEL_ID     = var.bedrock_text_model_id
    BEDROCK_KNOWLEDGE_BASE_ID = module.storage.knowledge_base_id
    BEDROCK_GUARDRAIL_ID      = module.storage.guardrail_id
    EVENT_BUS_NAME            = local.event_bus_name
  }

  policy_statements = [
    {
      actions   = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
      resources = [module.dynamodb.table_arn, "${module.dynamodb.table_arn}/index/*"]
    },
    {
      # Scoped to the specific models. `bedrock:InvokeModel` on "*" lets a
      # compromised function run any model in any region, on your bill.
      actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      resources = [
        "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.bedrock_text_model_id}",
        "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.titan-embed-text-v2:0",
      ]
    },
    {
      actions   = ["bedrock:Retrieve", "bedrock:RetrieveAndGenerate"]
      resources = ["arn:aws:bedrock:${var.aws_region}:*:knowledge-base/${module.storage.knowledge_base_id}"]
    },
    {
      actions   = ["bedrock:ApplyGuardrail"]
      resources = ["arn:aws:bedrock:${var.aws_region}:*:guardrail/${module.storage.guardrail_id}"]
    },
    {
      actions   = ["rds-data:ExecuteStatement", "rds-data:BatchExecuteStatement"]
      resources = [module.aurora.cluster_arn]
    },
    {
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [module.aurora.secret_arn]
    },
    {
      actions   = ["events:PutEvents"]
      resources = [local.event_bus_arn]
    },
  ]
}

module "lambda_rest" {
  source     = "../../modules/lambda"
  name       = "${local.name_prefix}-rest"
  env        = var.env
  handler    = "api/rest-handler.handler"
  source_dir = local.src_root
  memory_mb  = 512

  environment = {
    TABLE_NAME         = module.dynamodb.table_name
    AURORA_CLUSTER_ARN = module.aurora.cluster_arn
    AURORA_SECRET_ARN  = module.aurora.secret_arn
  }

  policy_statements = [{
    actions   = ["dynamodb:Query", "dynamodb:GetItem"]
    resources = [module.dynamodb.table_arn, "${module.dynamodb.table_arn}/index/*"]
  }]
}

# The five pipeline steps. for_each so adding a step is one line.
module "lambda_pipeline" {
  source = "../../modules/lambda"

  for_each = {
    collect   = { memory = 512, timeout = 120 }
    normalise = { memory = 512, timeout = 60 }
    enrich    = { memory = 512, timeout = 60 }
    detect    = { memory = 1024, timeout = 60 }
    publish   = { memory = 512, timeout = 60 }
  }

  name            = "${local.name_prefix}-${each.key}"
  env             = var.env
  handler         = "pipeline/steps.${each.key}"
  source_dir      = local.src_root
  memory_mb       = each.value.memory
  timeout_seconds = each.value.timeout

  # Caps the blast radius: even a runaway ingest cannot consume the whole
  # account's Lambda concurrency and starve the user-facing API.
  reserved_concurrency = 20

  environment = {
    TABLE_NAME     = module.dynamodb.table_name
    RAW_BUCKET     = module.storage.raw_bucket
    EVENT_BUS_NAME = local.event_bus_name
  }

  policy_statements = [
    {
      actions   = ["dynamodb:PutItem", "dynamodb:BatchWriteItem", "dynamodb:Query"]
      resources = [module.dynamodb.table_arn, "${module.dynamodb.table_arn}/index/*"]
    },
    {
      # PutObject only. The ingest pipeline has no business READING the raw
      # archive, let alone deleting from it.
      actions   = ["s3:PutObject"]
      resources = ["${module.storage.raw_bucket_arn}/raw/*"]
    },
    {
      actions   = ["events:PutEvents"]
      resources = [local.event_bus_arn]
    },
    {
      # Vendor API keys. Enumerated by path prefix, not "*".
      actions   = ["secretsmanager:GetSecretValue"]
      resources = ["arn:aws:secretsmanager:${var.aws_region}:*:secret:${local.name_prefix}/providers/*"]
    },
  ]
}

module "lambda_notifier" {
  source     = "../../modules/lambda"
  name       = "${local.name_prefix}-notifier"
  env        = var.env
  handler    = "pipeline/notifier.handler"
  source_dir = local.src_root
  memory_mb  = 256

  policy_statements = [{
    actions   = ["sns:Publish"]
    resources = ["arn:aws:sns:${var.aws_region}:*:${local.name_prefix}-alerts"]
  }]
}

# -----------------------------------------------------------------------------
# Identity, APIs, orchestration
# -----------------------------------------------------------------------------

module "cognito" {
  source        = "../../modules/cognito"
  name_prefix   = local.name_prefix
  env           = var.env
  callback_urls = local.callback_urls
  logout_urls   = local.logout_urls

  pre_token_generation_lambda_arn = module.lambda_pre_token.arn

  # Never in tfvars. Injected from Secrets Manager / GitHub OIDC at plan time.
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
  saml_metadata_url    = var.saml_metadata_url
  oidc_issuer          = var.oidc_issuer
}

module "appsync" {
  source              = "../../modules/appsync"
  name_prefix         = local.name_prefix
  env                 = var.env
  schema_path         = "${local.src_root}/api/schema.graphql"
  resolver_code_dir   = "${local.src_root}/api/vtl"
  user_pool_id        = module.cognito.user_pool_id
  aws_region          = var.aws_region
  resolver_lambda_arn = module.lambda_graphql.arn
  dynamodb_table_name = module.dynamodb.table_name
  dynamodb_table_arn  = module.dynamodb.table_arn
}

module "api_gateway" {
  source                = "../../modules/api-gateway"
  name_prefix           = local.name_prefix
  env                   = var.env
  rest_lambda_arn       = module.lambda_rest.arn
  authorizer_lambda_arn = module.lambda_authorizer.arn
  cognito_issuer        = module.cognito.issuer
  cognito_client_id     = module.cognito.client_id
  cors_origins          = local.cors_origins
}

module "step_functions" {
  source          = "../../modules/step-functions"
  name_prefix     = local.name_prefix
  env             = var.env
  definition_path = "${local.src_root}/pipeline/state-machine.asl.json"
  event_bus_name  = local.event_bus_name
  event_bus_arn   = local.event_bus_arn

  lambda_arns = {
    for k, m in module.lambda_pipeline : k => m.arn
  }
}

module "eventbridge" {
  source                   = "../../modules/eventbridge"
  name_prefix              = local.name_prefix
  env                      = var.env
  ingest_state_machine_arn = module.step_functions.state_machine_arn
  notifier_lambda_arn      = module.lambda_notifier.arn
  agent_lambda_arn         = module.lambda_graphql.arn
}

# -----------------------------------------------------------------------------
# Outputs the front-end and the CI pipeline need
# -----------------------------------------------------------------------------

output "graphql_endpoint" { value = module.appsync.graphql_endpoint }
output "realtime_endpoint" { value = module.appsync.realtime_endpoint }
output "rest_endpoint" { value = module.api_gateway.api_endpoint }
output "cognito_user_pool_id" { value = module.cognito.user_pool_id }
output "cognito_client_id" { value = module.cognito.client_id }
output "cognito_hosted_ui" { value = module.cognito.hosted_ui_domain }
output "state_machine_arn" { value = module.step_functions.state_machine_arn }
output "raw_bucket" { value = module.storage.raw_bucket }

# Consumed by the deploy pipeline for migrations and knowledge-base sync.
output "aurora_cluster_arn" { value = module.aurora.cluster_arn }
output "aurora_secret_arn" { value = module.aurora.secret_arn }
output "runbooks_bucket" { value = module.storage.runbooks_bucket }
output "knowledge_base_id" { value = module.storage.knowledge_base_id }
output "knowledge_base_data_source_id" { value = module.storage.knowledge_base_data_source_id }
