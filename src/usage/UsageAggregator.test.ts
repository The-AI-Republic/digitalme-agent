import test from 'node:test';
import assert from 'node:assert/strict';

import { UsageAggregator } from './UsageAggregator.js';
import type { ConversationUsage, ModelUsageRecord } from './types.js';

function makeRecord(overrides?: Partial<ModelUsageRecord>): ModelUsageRecord {
  return {
    requestId: 'req-1',
    conversationId: 'conv-1',
    timestamp: Date.now(),
    provider: 'openai',
    model: 'gpt-4o',
    executionContext: 'main',
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.001,
    turnNumber: 1,
    toolCallCount: 0,
    isRetry: false,
    isFallback: false,
    ...overrides,
  };
}

function makeConversationUsage(overrides?: Partial<ConversationUsage>): ConversationUsage {
  return {
    conversationId: 'conv-1',
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalEstimatedCostUsd: 0.001,
    turnCount: 1,
    modelCallCount: 1,
    toolCallCount: 0,
    mainConversationCost: 0.001,
    backgroundWorkCost: 0,
    costByModel: { 'openai:gpt-4o': 0.001 },
    ...overrides,
  };
}

test('UsageAggregator starts empty', () => {
  const agg = new UsageAggregator();
  assert.equal(agg.getTotalCost(), 0);
  assert.equal(agg.getDailyCost(), 0);
  assert.equal(agg.getMonthlyCost(), 0);
});

test('UsageAggregator.updateConversation stores usage', () => {
  const agg = new UsageAggregator();
  agg.updateConversation(makeConversationUsage({ conversationId: 'c1', totalEstimatedCostUsd: 0.01 }));
  agg.updateConversation(makeConversationUsage({ conversationId: 'c2', totalEstimatedCostUsd: 0.02 }));

  assert.equal(agg.getTotalCost(), 0.03);
});

test('UsageAggregator.updateConversation replaces previous usage for same conversation', () => {
  const agg = new UsageAggregator();
  agg.updateConversation(makeConversationUsage({ conversationId: 'c1', totalEstimatedCostUsd: 0.01 }));
  agg.updateConversation(makeConversationUsage({ conversationId: 'c1', totalEstimatedCostUsd: 0.05 }));

  assert.equal(agg.getTotalCost(), 0.05);
});

test('UsageAggregator.recordUsage tracks daily aggregates', () => {
  const agg = new UsageAggregator();
  const today = new Date().toISOString().slice(0, 10);

  agg.recordUsage(makeRecord({ estimatedCostUsd: 0.01, timestamp: Date.now() }));
  agg.recordUsage(makeRecord({ estimatedCostUsd: 0.02, timestamp: Date.now() }));

  assert.equal(agg.getDailyCost(today), 0.03);
});

test('UsageAggregator.getDailyCost returns 0 for days without usage', () => {
  const agg = new UsageAggregator();
  assert.equal(agg.getDailyCost('2020-01-01'), 0);
});

test('UsageAggregator.getMonthlyCost sums all daily buckets for the month', () => {
  const agg = new UsageAggregator();
  // Create records for two different days in the same month
  const day1 = new Date('2026-04-10T12:00:00Z').getTime();
  const day2 = new Date('2026-04-11T12:00:00Z').getTime();

  agg.recordUsage(makeRecord({ estimatedCostUsd: 0.01, timestamp: day1 }));
  agg.recordUsage(makeRecord({ estimatedCostUsd: 0.02, timestamp: day2 }));

  assert.equal(agg.getMonthlyCost('2026-04'), 0.03);
});

test('UsageAggregator.getMonthlyCost excludes other months', () => {
  const agg = new UsageAggregator();
  const march = new Date('2026-03-15T12:00:00Z').getTime();
  const april = new Date('2026-04-15T12:00:00Z').getTime();

  agg.recordUsage(makeRecord({ estimatedCostUsd: 0.01, timestamp: march }));
  agg.recordUsage(makeRecord({ estimatedCostUsd: 0.02, timestamp: april }));

  assert.equal(agg.getMonthlyCost('2026-04'), 0.02);
});

test('UsageAggregator.removeConversation removes from total cost', () => {
  const agg = new UsageAggregator();
  agg.updateConversation(makeConversationUsage({ conversationId: 'c1', totalEstimatedCostUsd: 0.01 }));
  agg.updateConversation(makeConversationUsage({ conversationId: 'c2', totalEstimatedCostUsd: 0.02 }));

  agg.removeConversation('c1');
  assert.equal(agg.getTotalCost(), 0.02);
});

test('UsageAggregator.getConversationUsage returns stored usage', () => {
  const agg = new UsageAggregator();
  const usage = makeConversationUsage({ conversationId: 'c1', totalEstimatedCostUsd: 0.05 });
  agg.updateConversation(usage);

  const retrieved = agg.getConversationUsage('c1');
  assert.ok(retrieved);
  assert.equal(retrieved.totalEstimatedCostUsd, 0.05);
});

test('UsageAggregator.getConversationUsage returns undefined for unknown conversation', () => {
  const agg = new UsageAggregator();
  assert.equal(agg.getConversationUsage('unknown'), undefined);
});

test('UsageAggregator.snapshot returns aggregated data', () => {
  const agg = new UsageAggregator();
  agg.updateConversation(makeConversationUsage({
    conversationId: 'c1',
    totalEstimatedCostUsd: 0.01,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    modelCallCount: 2,
    turnCount: 1,
  }));
  agg.updateConversation(makeConversationUsage({
    conversationId: 'c2',
    totalEstimatedCostUsd: 0.02,
    totalInputTokens: 200,
    totalOutputTokens: 100,
    modelCallCount: 3,
    turnCount: 2,
  }));

  const snapshot = agg.snapshot();
  assert.equal(snapshot.totalCostUsd, 0.03);
  assert.equal(snapshot.totalTokens.input, 300);
  assert.equal(snapshot.totalTokens.output, 150);
  assert.equal(snapshot.conversationCount, 2);
  assert.ok(snapshot.avgCostPerConversation > 0);
  assert.equal(snapshot.conversations.length, 2);
});

test('UsageAggregator.snapshot respects since filter', () => {
  const agg = new UsageAggregator();
  const oldTime = Date.now() - 100000;
  const newTime = Date.now();

  agg.updateConversation(makeConversationUsage({
    conversationId: 'old',
    startedAt: oldTime,
    lastUpdatedAt: oldTime,
    totalEstimatedCostUsd: 0.01,
  }));
  agg.updateConversation(makeConversationUsage({
    conversationId: 'new',
    startedAt: newTime,
    lastUpdatedAt: newTime,
    totalEstimatedCostUsd: 0.02,
  }));

  const snapshot = agg.snapshot(newTime - 1);
  assert.equal(snapshot.conversationCount, 1);
  assert.equal(snapshot.totalCostUsd, 0.02);
});

test('UsageAggregator.pruneOldBuckets removes old daily data', () => {
  const agg = new UsageAggregator();
  // Add record from 60 days ago
  const oldTime = Date.now() - 60 * 24 * 60 * 60 * 1000;
  agg.recordUsage(makeRecord({ estimatedCostUsd: 0.01, timestamp: oldTime }));
  // Add record from today
  agg.recordUsage(makeRecord({ estimatedCostUsd: 0.02, timestamp: Date.now() }));

  const pruned = agg.pruneOldBuckets(30); // Keep last 30 days
  assert.equal(pruned, 1);
  // Today's data should still be there
  assert.ok(agg.getDailyCost() > 0);
});

test('UsageAggregator.recordUsage tracks conversations per daily bucket', () => {
  const agg = new UsageAggregator();
  agg.recordUsage(makeRecord({ conversationId: 'c1', timestamp: Date.now() }));
  agg.recordUsage(makeRecord({ conversationId: 'c2', timestamp: Date.now() }));
  agg.recordUsage(makeRecord({ conversationId: 'c1', timestamp: Date.now() }));

  // Daily cost should be sum of all records
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(agg.getDailyCost(today), 0.003);
});
