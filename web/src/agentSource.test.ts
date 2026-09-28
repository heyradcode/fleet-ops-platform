import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSource } from './agentSource.ts';
import type { AgentResult } from './transport/index.ts';

const r = (servedBy?: AgentResult['servedBy']) => ({ servedBy } as AgentResult);

test('the source line says where, which model, and the turn from the second on', () => {
  assert.equal(agentSource(r({ host: 'agentcore', model: 'offline', turn: 1 })), ' · via AgentCore (offline model)');
  assert.equal(agentSource(r({ host: 'agentcore', model: 'anthropic.claude-opus-5', turn: 3 })), ' · via AgentCore (claude-opus-5) · turn 3');
  assert.equal(agentSource(r({ host: 'tab', model: 'offline', turn: 1 })), ' · in this tab (offline model)');
  assert.equal(agentSource(r({ host: 'agentcore', model: 'offline', turn: 2, tools: 'mcp' })), ' · via AgentCore (offline model) · tools over MCP · turn 2');
  assert.equal(agentSource(r({ host: 'agentcore', model: 'offline', turn: 1, tools: 'in-process' })), ' · via AgentCore (offline model)');
  assert.equal(agentSource(r({ host: 'agentcore', model: 'offline', turn: 1, tools: 'mcp', toolsRoute: 'gateway' })),
    ' · via AgentCore (offline model) · tools over MCP via Gateway');
  assert.equal(agentSource(r({ host: 'agentcore', model: 'offline', turn: 1, tools: 'mcp', toolsRoute: 'direct' })),
    ' · via AgentCore (offline model) · tools over MCP', 'direct is the plain case and says nothing extra');
  assert.equal(agentSource(r(undefined)), '', 'an older agent that does not say is not guessed at');
});
