import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenBudget } from './TokenBudget.js';
import { generateId } from '../../models/ModelClient.js';
import type { TokenBudgetConfig } from './types.js';

function makeConfig(overrides?: Partial<TokenBudgetConfig>): TokenBudgetConfig {
  return {
    modelMetadata: {
      'gpt-4o': { contextWindowSize: 128000, maxOutputTokens: 16384 },
      'small-model': { contextWindowSize: 8000, maxOutputTokens: 1000 },
    },
    defaultContextWindowSize: 128000,
    defaultMaxOutputTokens: 4096,
    microcompactRatio: 0.5,
    projectionRatio: 0.7,
    overflowRatio: 0.9,
    safetyMargin: 1.33,
    ...overrides,
  };
}

test('getEffectiveWindow resolves known model', () => {
  const budget = new TokenBudget(makeConfig());
  assert.equal(budget.getEffectiveWindow('gpt-4o'), 128000 - 16384);
});

test('getEffectiveWindow uses defaults for unknown model', () => {
  const budget = new TokenBudget(makeConfig());
  assert.equal(budget.getEffectiveWindow('unknown-model'), 128000 - 4096);
});

test('getEffectiveWindow resolves small model', () => {
  const budget = new TokenBudget(makeConfig());
  assert.equal(budget.getEffectiveWindow('small-model'), 8000 - 1000);
});

test('estimateTokens uses lastKnownUsage when available', () => {
  const budget = new TokenBudget(makeConfig());
  const estimate = budget.estimateTokens([], { inputTokens: 500, outputTokens: 100, totalTokens: 600 });
  assert.equal(estimate, 600);
});

test('estimateTokens estimates from content when no usage', () => {
  const budget = new TokenBudget(makeConfig());
  const messages = [
    { role: 'user' as const, content: 'a'.repeat(400), id: generateId() },
  ];
  const estimate = budget.estimateTokens(messages);
  // 400 chars / 4 bytes per token = 100 tokens * 1.33 safety = 133
  assert.equal(estimate, 133);
});

test('estimateTokens includes tool call arguments', () => {
  const budget = new TokenBudget(makeConfig());
  const messages = [
    {
      role: 'assistant' as const,
      content: null,
      id: generateId(),
      toolCalls: [{
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'search', arguments: 'a'.repeat(100) },
      }],
    },
  ];
  const estimate = budget.estimateTokens(messages);
  // (6 + 100) chars / 4 = 26.5 -> 27 * 1.33 = 35.91 -> 36
  assert.equal(estimate, 36);
});

test('assessPressure returns nominal for small context', () => {
  const budget = new TokenBudget(makeConfig());
  const messages = [
    { role: 'user' as const, content: 'hello', id: generateId() },
  ];
  assert.equal(budget.assessPressure('gpt-4o', messages), 'nominal');
});

test('assessPressure returns overflow for huge context', () => {
  const budget = new TokenBudget(makeConfig());
  // gpt-4o effective window = 111616. overflow at 0.9 = 100454
  // Need > 100454 tokens. With 1.33 safety, need content of ~100454 / 1.33 * 4 = ~302K chars
  const messages = [
    { role: 'user' as const, content: 'a'.repeat(400000), id: generateId() },
  ];
  assert.equal(budget.assessPressure('gpt-4o', messages), 'overflow');
});

test('assessPressure uses lastKnownUsage for grounded assessment', () => {
  const budget = new TokenBudget(makeConfig());
  // gpt-4o effective = 111616, projection threshold = 111616 * 0.7 = 78131
  const usage = { inputTokens: 80000, outputTokens: 0, totalTokens: 80000 };
  assert.equal(budget.assessPressure('gpt-4o', [], usage), 'projection');
});

test('assessPressure returns microcompact band correctly', () => {
  const budget = new TokenBudget(makeConfig());
  // effective = 111616, microcompact threshold = 111616 * 0.5 = 55808
  const usage = { inputTokens: 60000, outputTokens: 0, totalTokens: 60000 };
  assert.equal(budget.assessPressure('gpt-4o', [], usage), 'microcompact');
});
