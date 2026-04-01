import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from './registry.js';
import { testConfig } from '../test/fixtures.js';
import type { AgentConfig } from '../config/schema.js';

test('empty registry when web search disabled', () => {
  const registry = new ToolRegistry(testConfig);
  assert.equal(registry.listNames().length, 0);
  assert.equal(registry.listDefinitions().length, 0);
  assert.equal(registry.get('web_search'), undefined);
});

test('registers web search tool when enabled', () => {
  const config: AgentConfig = {
    ...testConfig,
    persona: {
      ...testConfig.persona,
      tools: { allow_web_search: true },
    },
  };
  const registry = new ToolRegistry(config);
  assert.deepEqual(registry.listNames(), ['web_search']);
  assert.equal(registry.listDefinitions().length, 1);
  assert.equal(registry.listDefinitions()[0].function.name, 'web_search');
  assert.ok(registry.get('web_search'));
});

test('get returns undefined for unknown tool', () => {
  const registry = new ToolRegistry(testConfig);
  assert.equal(registry.get('nonexistent'), undefined);
});
