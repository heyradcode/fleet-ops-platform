/**
 * The two AgentCore addresses. Both receive a user's bearer token, so both
 * refuse anything that is not what they claim to be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayTargetUrl, runtimeInvocationUrl } from './agentcore-url.ts';

test('a runtime is addressed by its encoded ARN, in its own region', () => {
  assert.equal(
    runtimeInvocationUrl('arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/netpulse_demo_mcp-abc'),
    'https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aeu-west-1%3A111122223333%3Aruntime%2Fnetpulse_demo_mcp-abc/invocations?qualifier=DEFAULT',
  );
});

test('a gateway target: the gateway origin, the target as one path segment, /invocations', () => {
  const host = 'https://gw-123abc.gateway.bedrock-agentcore.us-east-1.amazonaws.com';
  assert.equal(gatewayTargetUrl(host, 'tools'), host + '/tools/invocations');
  // An MCP-type gateway's URL ends in /mcp; the origin is what matters.
  assert.equal(gatewayTargetUrl(host + '/mcp', 'tools'), host + '/tools/invocations');
  assert.equal(gatewayTargetUrl(host, 'a/b'), host + '/a%2Fb/invocations');
});

test('anything that is not an AgentCore gateway is refused - this URL is sent the caller\'s token', () => {
  for (const bad of [
    'http://gw-1.gateway.bedrock-agentcore.us-east-1.amazonaws.com',          // not TLS
    'https://gw-1.gateway.bedrock-agentcore.us-east-1.amazonaws.com.evil.io', // lookalike
    'https://bedrock-agentcore.us-east-1.amazonaws.com',                       // a runtime, not a gateway
    'not a url',
  ]) {
    assert.throws(() => gatewayTargetUrl(bad, 'tools'), /not an AgentCore gateway URL|not a URL/, bad);
  }
  assert.throws(() => gatewayTargetUrl('https://gw-1.gateway.bedrock-agentcore.us-east-1.amazonaws.com', ''), /no gateway target/);
});
