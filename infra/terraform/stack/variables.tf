# =============================================================================
# Stack inputs
# =============================================================================
# Deliberately SMALL. Every variable declared here has to be re-declared in any
# root module that wants to pass it, because a Terraform root cannot inherit
# variable declarations - there is no `include`. So each variable you add here
# is a line of boilerplate multiplied by the number of environments.
#
# Three rules keep the surface down:
#
#   1. Anything DERIVABLE is derived. Callback URLs, logout URLs and CORS
#      origins all follow mechanically from one app origin.
#   2. Anything DISCOVERABLE is looked up. The VPC and its subnets are found by
#      tag in main.tf rather than passed in as three more ids.
#   3. Anything that varies only by ENVIRONMENT is a conditional on `var.env`
#      inside the modules - log retention, capacity, PITR, MFA and so on.
#
# What is left is what genuinely has to be told to the stack from outside.

variable "env" {
  description = "Environment name. Drives retention, sizing and protection flags throughout."
  type        = string

  validation {
    condition     = contains(["dev", "test", "stage", "prod"], var.env)
    error_message = "env must be one of: dev, test, stage, prod."
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

# --- Front-end ---------------------------------------------------------------

variable "app_origin" {
  description = <<-EOT
    The SPA's origin, scheme and port included, with no trailing slash.
    e.g. "http://localhost:5173" or "https://app.netpulse.example.com".

    Cognito callback/logout URLs and the API's CORS allow-list are all derived
    from this - they were three separate variables that always moved together,
    which is the definition of one variable wearing three hats.
  EOT
  type        = string

  validation {
    condition     = can(regex("^https?://[^/]+$", var.app_origin))
    error_message = "app_origin must be a scheme + host with no trailing slash."
  }
}

variable "extra_callback_urls" {
  description = "Additional Cognito callback URLs beyond the one derived from app_origin (native apps, preview deployments)."
  type        = list(string)
  default     = []
}

# --- Secrets -----------------------------------------------------------------
# The only values a root module still needs to declare, because they are the
# only ones injected at apply time rather than known when the code is written.
# CI reads them from Secrets Manager and exports TF_VAR_google_client_id etc.
#
# `sensitive = true` redacts a value from OUTPUT. It does NOT encrypt it in
# STATE - state is plaintext JSON. That is why the state bucket is encrypted,
# versioned and locked down, and why nobody gets console read access to it.

variable "google_client_id" {
  type      = string
  sensitive = true
}

variable "google_client_secret" {
  type      = string
  sensitive = true
}

# --- Enterprise SSO (per-customer, so not every environment has one) ---------

variable "saml_metadata_url" {
  type    = string
  default = ""
}

variable "oidc_issuer" {
  type    = string
  default = ""
}

# --- AI ----------------------------------------------------------------------

variable "bedrock_text_model_id" {
  description = "Bedrock model id. Note the `anthropic.` prefix - Bedrock ids differ from first-party Anthropic API ids."
  type        = string
  default     = "anthropic.claude-opus-5"
}
