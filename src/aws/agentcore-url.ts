/**
 * The HTTPS address of an AgentCore Runtime, from its ARN.
 *
 *   https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{URL-encoded ARN}/invocations?qualifier=DEFAULT
 *
 * One definition for every caller: the board calling the agent, and the agent
 * calling the MCP server (which is invoked through the same address - AgentCore
 * passes the body through to the server's /mcp). The region is the ARN's
 * fourth field, so a runtime is always addressed in its own region.
 */
export function runtimeInvocationUrl(arn: string): string {
  const region = arn.split(':')[3];
  if (!arn.startsWith('arn:aws:bedrock-agentcore:') || !region) {
    throw new Error('not an AgentCore runtime ARN: ' + arn);
  }
  return 'https://bedrock-agentcore.' + region + '.amazonaws.com/runtimes/' +
    encodeURIComponent(arn) + '/invocations?qualifier=DEFAULT';
}

/**
 * The address of one target behind an AgentCore Gateway.
 *
 *   https://{gatewayId}.gateway.bedrock-agentcore.{region}.amazonaws.com/{targetName}/invocations
 *
 * For an AgentCore Runtime target the gateway forwards the request to that
 * runtime unchanged - here, the MCP server - so the client speaks exactly
 * the protocol it spoke to the runtime directly; only the address moves.
 *
 * Built from the gateway's own URL (Terraform's `gateway_url`) by its ORIGIN,
 * so a URL that arrives with a path - an MCP-type gateway's ends in `/mcp` -
 * cannot produce `/mcp/tools/invocations`. The target name is a path segment,
 * encoded as one. Refuses anything that is not an AgentCore gateway host:
 * this URL receives the caller's bearer token, and a typo in an environment
 * variable should fail at start, not post someone's token elsewhere.
 */
export function gatewayTargetUrl(gatewayUrl: string, targetName: string): string {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw new Error('not a URL: ' + gatewayUrl);
  }
  if (url.protocol !== 'https:' || !/\.gateway\.bedrock-agentcore\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) {
    throw new Error('not an AgentCore gateway URL: ' + gatewayUrl);
  }
  if (!targetName) throw new Error('no gateway target name');
  return url.origin + '/' + encodeURIComponent(targetName) + '/invocations';
}
