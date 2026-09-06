variable "region" {
  description = "Where the pool lives. It is part of the issuer URL, so moving it later invalidates every existing token."
  type        = string
  default     = "us-east-1"
}

variable "env" {
  description = "Environment name. Used in every resource name, so it is also what keeps two applies from colliding."
  type        = string
  default     = "demo"
}

variable "app_urls" {
  description = "Origins the board is served from, WITHOUT a trailing slash. Cognito matches redirect URIs exactly. localhost:5180 is added automatically."
  type        = list(string)
}

variable "alert_email" {
  description = "Where the budget alarm goes. Required - see the note on the budget resource."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Budget ceiling. This stack should cost pennies; a low number is the point."
  type        = string
  default     = "5"
}

variable "google_client_id" {
  description = "Google OAuth client id. Empty means no Google sign-in."
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth client secret. Never in a .tfvars that is committed - pass it with -var or TF_VAR_google_client_secret."
  type        = string
  default     = ""
  sensitive   = true
}
