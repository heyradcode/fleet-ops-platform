# -----------------------------------------------------------------------------
# What the board needs
# -----------------------------------------------------------------------------
# These three become environment variables on Vercel. Together they flip
# web/src/auth/provider.ts from the local issuer to the real pool; with any of
# them missing the board keeps using the offline provider, which is the correct
# default rather than a broken state.

output "vercel_env" {
  description = "Paste these into the Vercel project's environment variables."
  value = {
    VITE_COGNITO_DOMAIN    = module.cognito.hosted_ui_domain
    VITE_COGNITO_CLIENT_ID = module.cognito.client_id
    VITE_COGNITO_ISSUER    = module.cognito.issuer
  }
}

output "user_pool_id" {
  description = "For the AWS console, and for creating the first users."
  value       = module.cognito.user_pool_id
}

output "hosted_ui_url" {
  description = "Open this to check the pool answers before wiring the board to it."
  value       = "https://${module.cognito.hosted_ui_domain}/login?client_id=${module.cognito.client_id}&response_type=code&scope=openid+email+profile&redirect_uri=${urlencode(local.callback_urls[0])}"
}
