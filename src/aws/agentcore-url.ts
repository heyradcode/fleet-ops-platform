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
