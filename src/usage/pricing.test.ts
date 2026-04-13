import test from 'node:test';
import assert from 'node:assert/strict';

import { getCostEstimate, getModelPricing, registerPricing, listPricings } from './pricing.js';

test('getModelPricing returns known pricing for openai gpt-4o', () => {
  const pricing = getModelPricing('openai', 'gpt-4o');
  assert.equal(pricing.provider, 'openai');
  assert.equal(pricing.model, 'gpt-4o');
  assert.equal(pricing.inputTokenCostPer1M, 2.5);
  assert.equal(pricing.outputTokenCostPer1M, 10.0);
});

test('getModelPricing returns known pricing for anthropic claude-sonnet-4-6', () => {
  const pricing = getModelPricing('anthropic', 'claude-sonnet-4-6');
  assert.equal(pricing.provider, 'anthropic');
  assert.equal(pricing.model, 'claude-sonnet-4-6');
  assert.equal(pricing.inputTokenCostPer1M, 3.0);
  assert.equal(pricing.outputTokenCostPer1M, 15.0);
  assert.equal(pricing.cacheReadCostPer1M, 0.3);
  assert.equal(pricing.cacheWriteCostPer1M, 3.75);
});

test('getModelPricing returns default pricing for unknown models', () => {
  const pricing = getModelPricing('unknown-provider', 'unknown-model');
  assert.equal(pricing.provider, 'unknown');
  assert.equal(pricing.model, 'unknown');
  assert.equal(pricing.inputTokenCostPer1M, 3.0);
  assert.equal(pricing.outputTokenCostPer1M, 15.0);
});

test('getCostEstimate computes correct cost for known model', () => {
  // gpt-4o: $2.5 per 1M input, $10 per 1M output
  const cost = getCostEstimate('openai', 'gpt-4o', 1000, 500);
  const expected = (1000 / 1_000_000) * 2.5 + (500 / 1_000_000) * 10.0;
  assert.equal(cost, expected);
});

test('getCostEstimate includes cache costs for anthropic models', () => {
  // claude-sonnet-4-6: cache read $0.3/1M, cache write $3.75/1M
  const cost = getCostEstimate('anthropic', 'claude-sonnet-4-6', 1000, 500, 2000, 500);
  const expected =
    (1000 / 1_000_000) * 3.0 +
    (500 / 1_000_000) * 15.0 +
    (2000 / 1_000_000) * 0.3 +
    (500 / 1_000_000) * 3.75;
  assert.equal(cost, expected);
});

test('getCostEstimate ignores cache tokens when pricing has no cache rates', () => {
  // gpt-4o has no cache pricing
  const withCache = getCostEstimate('openai', 'gpt-4o', 1000, 500, 2000, 500);
  const withoutCache = getCostEstimate('openai', 'gpt-4o', 1000, 500, 0, 0);
  assert.equal(withCache, withoutCache);
});

test('getCostEstimate returns 0 for zero tokens', () => {
  const cost = getCostEstimate('openai', 'gpt-4o', 0, 0);
  assert.equal(cost, 0);
});

test('registerPricing adds custom model pricing', () => {
  registerPricing({
    provider: 'custom',
    model: 'my-model',
    inputTokenCostPer1M: 1.0,
    outputTokenCostPer1M: 5.0,
  });
  const pricing = getModelPricing('custom', 'my-model');
  assert.equal(pricing.provider, 'custom');
  assert.equal(pricing.model, 'my-model');
  assert.equal(pricing.inputTokenCostPer1M, 1.0);
});

test('registerPricing overrides existing pricing', () => {
  registerPricing({
    provider: 'openai',
    model: 'gpt-4o',
    inputTokenCostPer1M: 99.0,
    outputTokenCostPer1M: 99.0,
  });
  const pricing = getModelPricing('openai', 'gpt-4o');
  assert.equal(pricing.inputTokenCostPer1M, 99.0);

  // Restore original pricing
  registerPricing({
    provider: 'openai',
    model: 'gpt-4o',
    inputTokenCostPer1M: 2.5,
    outputTokenCostPer1M: 10.0,
  });
});

test('listPricings returns all registered models', () => {
  const pricings = listPricings();
  assert.ok(pricings.length > 10, 'should have many pre-registered models');
  const gpt4o = pricings.find(p => p.provider === 'openai' && p.model === 'gpt-4o');
  assert.ok(gpt4o, 'should include gpt-4o');
});
