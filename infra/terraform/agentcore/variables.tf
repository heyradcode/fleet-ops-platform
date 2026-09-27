variable "region" {
  description = "Must match ../auth - the pool and the table live there."
  type        = string
  default     = "us-east-1"
}

variable "env" {
  type    = string
  default = "demo"
}

variable "agent_model" {
  description = <<-EOT
    The model behind the agent loop: a Claude model id on Bedrock
    ("anthropic.claude-opus-5", "anthropic.claude-sonnet-5", ...), or "offline"
    for the repo's scripted model - no Bedrock call, no token cost, and what
    to use until the account has Anthropic model access.
  EOT
  type        = string
  default     = "anthropic.claude-opus-5"
}

variable "agent_fallback_model" {
  description = "Tried once on the same request when agent_model refuses (client-side fallback - Bedrock has no server-side one). Empty disables it."
  type        = string
  default     = "anthropic.claude-opus-4-8"
}

variable "idle_session_timeout_seconds" {
  description = "How long an idle session's microVM (and its billed memory) is kept."
  type        = number
  default     = 300
}
