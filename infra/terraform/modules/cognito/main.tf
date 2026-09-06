# =============================================================================
# Cognito user pool with social + enterprise federation
# =============================================================================
# In a production repo each module is split into main.tf / variables.tf /
# outputs.tf. They are combined here so each module reads as one story.

variable "name_prefix" { type = string }
variable "env" { type = string }
variable "callback_urls" { type = list(string) }
variable "logout_urls" { type = list(string) }
variable "pre_token_generation_lambda_arn" { type = string }

variable "google_client_id" {
  type      = string
  sensitive = true
}

variable "google_client_secret" {
  type      = string
  sensitive = true
}

variable "saml_metadata_url" {
  type    = string
  default = ""
}

variable "oidc_issuer" {
  type    = string
  default = ""
}

data "aws_region" "current" {}

# -----------------------------------------------------------------------------
# The user pool
# -----------------------------------------------------------------------------

resource "aws_cognito_user_pool" "main" {
  name = "${var.name_prefix}-users"

  # Email is an alias, so users sign in with an email while the underlying
  # username stays immutable - emails change hands, identities must not.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }

  # Advanced security catches credential stuffing and impossible travel. It is
  # the highest-value paid Cognito feature; AUDIT in lower envs for cost.
  user_pool_add_ons {
    advanced_security_mode = var.env == "prod" ? "ENFORCED" : "AUDIT"
  }

  mfa_configuration = var.env == "prod" ? "OPTIONAL" : "OFF"

  software_token_mfa_configuration {
    enabled = true
  }

  # Custom attributes CANNOT be renamed or removed once created, and there is a
  # hard cap of 50 per pool. This is a one-way door - think before adding one.
  schema {
    name                     = "tenantId"
    attribute_data_type      = "String"
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 1
      max_length = 64
    }
  }

  # The trigger that stamps tenant + roles into every token.
  lambda_config {
    pre_token_generation = var.pre_token_generation_lambda_arn
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  deletion_protection = var.env == "prod" ? "ACTIVE" : "INACTIVE"

  tags = {
    Environment = var.env
  }
}

# -----------------------------------------------------------------------------
# Social identity providers
# -----------------------------------------------------------------------------

resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    authorize_scopes = "profile email openid"
  }

  # Map username to the Google `sub`, never to email.
  attribute_mapping = {
    email       = "email"
    username    = "sub"
    given_name  = "given_name"
    family_name = "family_name"
  }
}

resource "aws_cognito_identity_provider" "facebook" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Facebook"
  provider_type = "Facebook"

  provider_details = {
    client_id        = var.google_client_id # replace with the Facebook app id
    client_secret    = var.google_client_secret
    authorize_scopes = "public_profile,email"
    api_version      = "v18.0"
  }

  # Facebook may return no email at all. The pool schema must tolerate that.
  attribute_mapping = {
    email    = "email"
    username = "id"
  }
}

resource "aws_cognito_identity_provider" "apple" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "SignInWithApple"
  provider_type = "SignInWithApple"

  provider_details = {
    client_id        = "com.meridian.web"
    team_id          = "ABCDE12345"
    key_id           = "FGHIJ67890"
    private_key      = var.google_client_secret # .p8 contents from Secrets Manager
    authorize_scopes = "email name"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

# -----------------------------------------------------------------------------
# Enterprise SSO
# -----------------------------------------------------------------------------

# Prefer MetadataURL over MetadataFile: Cognito then re-fetches the customer's
# certificate on rotation, instead of the cert expiring at 2am on a Sunday.
resource "aws_cognito_identity_provider" "saml" {
  count = var.saml_metadata_url == "" ? 0 : 1

  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "AcmeSAML"
  provider_type = "SAML"

  provider_details = {
    MetadataURL = var.saml_metadata_url
    IDPSignout  = "true"
  }

  # SAML claim names are URIs. Copy them verbatim from the IdP metadata.
  attribute_mapping = {
    email             = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
    "custom:tenantId" = "http://schemas.acme.com/claims/tenant"
  }
}

resource "aws_cognito_identity_provider" "oidc" {
  count = var.oidc_issuer == "" ? 0 : 1

  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "OktaOIDC"
  provider_type = "OIDC"

  provider_details = {
    oidc_issuer               = var.oidc_issuer
    client_id                 = var.google_client_id
    client_secret             = var.google_client_secret
    authorize_scopes          = "openid email profile groups"
    attributes_request_method = "GET"
  }

  attribute_mapping = {
    email             = "email"
    "custom:tenantId" = "org_id"
  }
}

# -----------------------------------------------------------------------------
# App client + groups
# -----------------------------------------------------------------------------

resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  # No client secret: this is a public SPA, and a secret in a browser bundle is
  # not a secret. PKCE provides the protection instead.
  generate_secret = false

  allowed_oauth_flows                  = ["code"] # never "implicit"
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  supported_identity_providers = compact([
    "COGNITO",
    aws_cognito_identity_provider.google.provider_name,
    aws_cognito_identity_provider.facebook.provider_name,
    aws_cognito_identity_provider.apple.provider_name,
    var.saml_metadata_url == "" ? "" : "AcmeSAML",
    var.oidc_issuer == "" ? "" : "OktaOIDC",
  ])

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  # Short access tokens, long rotating refresh tokens. A leaked access token is
  # then useful for at most an hour.
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED" # do not leak which emails exist

  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH", # SRP never puts the password on the wire
  ]

  read_attributes = ["email", "email_verified", "custom:tenantId"]

  # Critically, tenantId is NOT writable. A user must never be able to move
  # themselves into another tenant by updating their own profile.
  write_attributes = ["email"]
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${var.name_prefix}-auth"
  user_pool_id = aws_cognito_user_pool.main.id
}

# Groups become the `cognito:groups` claim, which the code maps to roles.
resource "aws_cognito_user_group" "roles" {
  for_each = toset(["admin", "operator", "viewer"])

  name         = each.key
  user_pool_id = aws_cognito_user_pool.main.id
  precedence   = each.key == "admin" ? 1 : each.key == "operator" ? 2 : 3
}

# -----------------------------------------------------------------------------

output "user_pool_id" { value = aws_cognito_user_pool.main.id }
output "user_pool_arn" { value = aws_cognito_user_pool.main.arn }
output "client_id" { value = aws_cognito_user_pool_client.web.id }

output "issuer" {
  value = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.main.id}"
}

output "hosted_ui_domain" {
  value = "${aws_cognito_user_pool_domain.main.domain}.auth.${data.aws_region.current.name}.amazoncognito.com"
}
