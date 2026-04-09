import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { ToolRegistry } from './registry.js';
import type { Tool, ToolMetadata } from './types.js';

function makeFakeTool(name: string): Tool {
  return {
    name,
    definition: {
      type: 'function',
      function: { name, description: `Tool ${name}`, parameters: {} },
    },
    metadata: {
      timeoutMs: 10_000,
      maxResultChars: 20_000,
      policyCategory: 'search',
    },
    inputSchema: z.object({}),
    async execute() {
      return { success: true, data: {}, renderForModel: () => 'ok' };
    },
  };
}

test('ToolRegistry.register adds tools', () => {
  const registry = new ToolRegistry();
  registry.register(makeFakeTool('tool_a'));
  assert.deepEqual(registry.listNames(), ['tool_a']);
});

test('ToolRegistry.register rejects duplicates', () => {
  const registry = new ToolRegistry();
  registry.register(makeFakeTool('tool_a'));
  assert.throws(() => registry.register(makeFakeTool('tool_a')), /Duplicate/);
});

test('registered tools appear in listDefinitions', () => {
  const registry = new ToolRegistry();
  registry.register(makeFakeTool('tool_a'));
  registry.register(makeFakeTool('tool_b'));
  const defs = registry.listDefinitions();
  assert.equal(defs.length, 2);
  assert.equal(defs[0]!.function.name, 'tool_a');
  assert.equal(defs[1]!.function.name, 'tool_b');
});

test('get returns the correct tool', () => {
  const registry = new ToolRegistry();
  registry.register(makeFakeTool('tool_a'));
  assert.equal(registry.get('tool_a')?.name, 'tool_a');
  assert.equal(registry.get('nonexistent'), undefined);
});
