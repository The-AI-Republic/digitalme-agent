import test from 'node:test';
import assert from 'node:assert/strict';

import { WebSearchTool } from './web-search.js';

const tool = new WebSearchTool();

test('WebSearchTool.inputSchema rejects empty query', () => {
  const result = tool.inputSchema.safeParse({ query: '' });
  assert.equal(result.success, false);
});

test('WebSearchTool.inputSchema accepts valid query', () => {
  const result = tool.inputSchema.safeParse({ query: 'hello world' });
  assert.equal(result.success, true);
});

test('WebSearchTool.isConcurrencySafe returns true', () => {
  assert.equal(tool.isConcurrencySafe!({ query: 'test' }), true);
});

test('WebSearchTool.definition.parameters matches schema shape', () => {
  const params = tool.definition.function.parameters;
  assert.equal((params as any).type, 'object');
  assert.ok((params as any).properties.query);
  assert.deepEqual((params as any).required, ['query']);
});

test('WebSearchTool.metadata has correct values', () => {
  assert.equal(tool.metadata.timeoutMs, 5_000);
  assert.equal(tool.metadata.maxResultChars, 4_000);
  assert.equal(tool.metadata.policyCategory, 'search');
});

test('WebSearchTool.summarizeResult produces summary', () => {
  const result = {
    success: true,
    data: { query: 'test', results: [{ text: 'a' }, { text: 'b' }] },
    renderForModel: () => 'rendered',
  };
  const summary = tool.summarizeResult!({ query: 'test' }, result);
  assert.ok(summary.includes('web_search'));
  assert.ok(summary.includes('2 results'));
});
