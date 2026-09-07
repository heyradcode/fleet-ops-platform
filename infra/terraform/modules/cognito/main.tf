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

variable "ui_css" {
  description = "Hosted UI stylesheet. Empty means leave Cognito's default. Validated server-side against a fixed class list."
  type        = string
  default     = ""
}

variable "domain_prefix" {
  description = "Hosted UI domain prefix. Globally unique across all AWS accounts. Empty derives it from name_prefix."
  type        = string
  default     = ""
}

variable "advanced_security_mode" {
  description = "OFF keeps the pool on the free feature plan. AUDIT and ENFORCED require Plus."
  type        = string
  default     = "AUDIT"
}

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

  # Threat protection catches credential stuffing and impossible travel. It is
  # the highest-value paid Cognito feature and it moves the pool onto the Plus
  # feature plan, so a demo pool that will never see an attack leaves it OFF
  # and stays on the free plan.
  user_pool_add_ons {
    advanced_security_mode = var.advanced_security_mode
  }

  mfa_configuration = var.env == "prod" ? "OPTIONAL" : "OFF"

  # Cognito REJECTS an MFA configuration while MFA is off - "can't turn off MFA
  # and configure an MFA together" - so the block has to disappear rather than
  # sit there harmlessly. A static block here fails the apply, not the plan.
  dynamic "software_token_mfa_configuration" {
    for_each = var.env == "prod" ? [1] : []
    content {
      enabled = true
    }
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
  #
  # V2_0, and that is not a preference. The V1 trigger can only add claims to
  # the ID token. Everything in this platform authorises on the ACCESS token -
  # `token_use: 'access'` is check 4 in auth/cognito-jwt-verifier.ts - so a
  # pool wired to V1 mints access tokens carrying no tenant claim, the verifier
  # correctly rejects every one of them, and the symptom is "nobody can sign
  # in" pointing at code that is behaving exactly as designed.
  lambda_config {
    pre_token_generation_config {
      lambda_arn     = var.pre_token_generation_lambda_arn
      lambda_version = "V2_0"
    }
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

# The social providers exist only when there are credentials for them. An
# identity provider created with an empty client_id is not a disabled provider,
# it is an apply-time error - which makes the whole pool unappliable for want
# of a Facebook app nobody wanted.
resource "aws_cognito_identity_provider" "google" {
  count = var.google_client_id == "" ? 0 : 1

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
  count = var.google_client_id == "" ? 0 : 1

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
  count = var.google_client_id == "" ? 0 : 1

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
    # Literal names, not references to the resources. A resource behind
    # `count = 0` has no attributes to read, so referencing one here would
    # break the pool for exactly the configuration that omits it.
    var.google_client_id == "" ? "" : "Google",
    var.google_client_id == "" ? "" : "Facebook",
    var.google_client_id == "" ? "" : "SignInWithApple",
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

# The hosted UI domain prefix is GLOBALLY unique - across every AWS account,
# not just yours - so an obvious name is probably already taken by a stranger,
# and the apply fails on it. Overridable for exactly that reason.
resource "aws_cognito_user_pool_domain" "main" {
  domain       = coalesce(var.domain_prefix, "${var.name_prefix}-auth")
  user_pool_id = aws_cognito_user_pool.main.id
}

# The hosted UI, in the board's palette.
#
# The redirect to Cognito is a real step in the PKCE flow, and an unstyled grey
# box in the middle of it reads as having left the product. This gets it close.
#
# Cognito validates the CSS server-side against a FIXED list of about seventeen
# classes and rejects the whole document on one unknown name - `.inputLabel-
# customizable` is NOT on it, though `.label-customizable` is. No font-family,
# no pseudo-elements, and the page background and link colour are not
# reachable at all, so this can get close to the board and never match it.
#
# Depends on the DOMAIN, not just the pool: there is no hosted UI to style
# until the domain exists, and Terraform cannot infer that ordering itself.
resource "aws_cognito_user_pool_ui_customization" "this" {
  count = var.ui_css == "" ? 0 : 1

  user_pool_id = aws_cognito_user_pool_domain.main.user_pool_id
  client_id    = aws_cognito_user_pool_client.web.id
  css          = var.ui_css
}

# Groups become the `cognito:groups` claim, which mapGroupsToRoles() in
# auth/cognito-jwt-verifier.ts maps to roles - and this list has to BE that
# list. It carried an "operator" group the platform has never heard of, and
# omitted dispatcher, safety and driver, which it uses constantly. The trigger
# overrides the claim on every login so nothing was visibly broken, which is
# exactly why it survived: a pool advertising roles the code cannot map, and
# missing the ones it can.
#
# An unmapped group degrades to `viewer` rather than crashing, so the failure
# mode of getting this wrong is silent under-permissioning.
resource "aws_cognito_user_group" "roles" {
  for_each = toset(["admin", "safety", "dispatcher", "driver", "viewer"])

  name         = each.key
  user_pool_id = aws_cognito_user_pool.main.id

  # Lower is higher priority. Cognito puts the lowest-precedence group first in
  # the claim, which matters when a user is in more than one.
  precedence = index(["admin", "safety", "dispatcher", "driver", "viewer"], each.key) + 1
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
