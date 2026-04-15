import test from 'node:test';
import assert from 'node:assert/strict';

import { builtInAgents, getBuiltInAgent } from './BuiltInAgents.js';

test('builtInAgents contains general-purpose agent', () => {
  const gp = builtInAgents.find((a) => a.agentType === 'general-purpose');
  assert.ok(gp);
  assert.equal(gp.tools, '*');
  assert.equal(gp.model, 'inherit');
  assert.ok(gp.maxTurns > 0);
});

test('builtInAgents have valid structure', () => {
  for (const agent of builtInAgents) {
    assert.ok(agent.agentType, 'agentType must be non-empty');
    assert.ok(agent.whenToUse, 'whenToUse must be non-empty');
    assert.ok(agent.tools === '*' || Array.isArray(agent.tools), 'tools must be * or array');
    assert.ok(agent.maxTurns > 0, 'maxTurns must be positive');
    assert.ok(typeof agent.getSystemPrompt === 'function', 'getSystemPrompt must be a function');
  }
});

test('getBuiltInAgent returns agent by type', () => {
  const agent = getBuiltInAgent('general-purpose');
  assert.ok(agent);
  assert.equal(agent.agentType, 'general-purpose');
});

test('getBuiltInAgent returns undefined for unknown type', () => {
  const agent = getBuiltInAgent('nonexistent-agent-type');
  assert.equal(agent, undefined);
});

test('general-purpose getSystemPrompt returns a non-empty string', () => {
  const agent = getBuiltInAgent('general-purpose')!;
  const prompt = agent.getSystemPrompt();
  assert.ok(typeof prompt === 'string' || prompt instanceof Promise);
  if (typeof prompt === 'string') {
    assert.ok(prompt.length > 0);
  }
});

test('all agent types are unique', () => {
  const types = builtInAgents.map((a) => a.agentType);
  const unique = new Set(types);
  assert.equal(unique.size, types.length, 'Duplicate agent types found');
});
