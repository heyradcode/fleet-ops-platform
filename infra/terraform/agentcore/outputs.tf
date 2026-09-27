output "agent_runtime_arn" {
  description = "What the board calls, and what InvokeAgentRuntime takes."
  value       = aws_bedrockagentcore_agent_runtime.agent.agent_runtime_arn
}

output "agent_runtime_version" {
  description = "Bumped by AgentCore on every update - a new build is a new version."
  value       = aws_bedrockagentcore_agent_runtime.agent.agent_runtime_version
}

# Read by `pnpm web:env` and merged into web/.env.cognito.local.
output "web_env" {
  description = "Set on the board's host alongside the Cognito variables."
  value = {
    VITE_AGENT_RUNTIME_ARN = aws_bedrockagentcore_agent_runtime.agent.agent_runtime_arn
  }
}
