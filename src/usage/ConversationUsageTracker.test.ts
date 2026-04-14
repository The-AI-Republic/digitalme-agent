import test from 'node:test';
import assert from 'node:assert/strict';

import { ConversationUsageTracker } from './ConversationUsageTracker.js';
import type { ModelUsageRecord } from './types.js';

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
    estimatedCostUsd: 0.00075,
    turnNumber: 1,
    toolCallCount: 0,
    isRetry: false,
    isFallback: false,
    ...overrides,
  };
}

test('ConversationUsageTracker initializes with zero usage', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  const usage = tracker.getUsage();
  assert.equal(usage.conversationId, 'conv-1');
  assert.equal(usage.totalInputTokens, 0);
  assert.equal(usage.totalOutputTokens, 0);
  assert.equal(usage.totalEstimatedCostUsd, 0);
  assert.equal(usage.turnCount, 0);
  assert.equal(usage.modelCallCount, 0);
  assert.equal(usage.toolCallCount, 0);
  assert.equal(usage.mainConversationCost, 0);
  assert.equal(usage.backgroundWorkCost, 0);
  assert.deepEqual(usage.costByModel, {});
});

test('ConversationUsageTracker.addRecord accumulates token counts', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  tracker.addRecord(makeRecord({ inputTokens: 100, outputTokens: 50 }));
  tracker.addRecord(makeRecord({ inputTokens: 200, outputTokens: 100 }));

  const usage = tracker.getUsage();
  assert.equal(usage.totalInputTokens, 300);
  assert.equal(usage.totalOutputTokens, 150);
  assert.equal(usage.modelCallCount, 2);
});

test('ConversationUsageTracker.addRecord accumulates cost', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  tracker.addRecord(makeRecord({ estimatedCostUsd: 0.01 }));
  tracker.addRecord(makeRecord({ estimatedCostUsd: 0.02 }));

  assert.equal(tracker.getTotalCost(), 0.03);
});

test('ConversationUsageTracker.addRecord tracks main vs background context', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  tracker.addRecord(makeRecord({ executionContext: 'main', estimatedCostUsd: 0.10 }));
  tracker.addRecord(makeRecord({ executionContext: 'background', estimatedCostUsd: 0.05 }));
  tracker.addRecord(makeRecord({ executionContext: 'main', estimatedCostUsd: 0.03 }));

  const usage = tracker.getUsage();
  assert.equal(usage.mainConversationCost, 0.13);
  assert.equal(usage.backgroundWorkCost, 0.05);
});

test('ConversationUsageTracker.addRecord tracks cost breakdown by model', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  tracker.addRecord(makeRecord({ provider: 'openai', model: 'gpt-4o', estimatedCostUsd: 0.10 }));
  tracker.addRecord(makeRecord({ provider: 'openai', model: 'gpt-4o-mini', estimatedCostUsd: 0.02 }));
  tracker.addRecord(makeRecord({ provider: 'openai', model: 'gpt-4o', estimatedCostUsd: 0.05 }));

  const usage = tracker.getUsage();
  assert.ok(Math.abs(usage.costByModel['openai:gpt-4o']! - 0.15) < 1e-10);
  assert.equal(usage.costByModel['openai:gpt-4o-mini'], 0.02);
});

test('ConversationUsageTracker.incrementTurnCount increases turn counter', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  assert.equal(tracker.getTurnCount(), 0);
  tracker.incrementTurnCount();
  tracker.incrementTurnCount();
  assert.equal(tracker.getTurnCount(), 2);
});

test('ConversationUsageTracker.setToolCallCount updates tool call count', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  tracker.setToolCallCount(5);
  assert.equal(tracker.getUsage().toolCallCount, 5);
});

test('ConversationUsageTracker.getTotalTokens sums input + output', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  tracker.addRecord(makeRecord({ inputTokens: 100, outputTokens: 50 }));
  tracker.addRecord(makeRecord({ inputTokens: 200, outputTokens: 100 }));
  assert.equal(tracker.getTotalTokens(), 450);
});

test('ConversationUsageTracker.getUsage returns a defensive copy', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  tracker.addRecord(makeRecord({ estimatedCostUsd: 0.01 }));

  const usage1 = tracker.getUsage() as { totalEstimatedCostUsd: number; costByModel: Record<string, number> };
  usage1.totalEstimatedCostUsd = 999;
  usage1.costByModel['fake'] = 999;

  const usage2 = tracker.getUsage();
  assert.equal(usage2.totalEstimatedCostUsd, 0.01);
  assert.equal(usage2.costByModel['fake'], undefined);
});

test('ConversationUsageTracker.restore restores from persisted snapshot', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  tracker.restore({
    conversationId: 'conv-1',
    startedAt: 1000,
    lastUpdatedAt: 2000,
    totalInputTokens: 500,
    totalOutputTokens: 200,
    totalEstimatedCostUsd: 0.05,
    turnCount: 3,
    modelCallCount: 5,
    toolCallCount: 2,
    mainConversationCost: 0.04,
    backgroundWorkCost: 0.01,
    costByModel: { 'openai:gpt-4o': 0.05 },
  });

  const usage = tracker.getUsage();
  assert.equal(usage.totalInputTokens, 500);
  assert.equal(usage.totalOutputTokens, 200);
  assert.equal(usage.totalEstimatedCostUsd, 0.05);
  assert.equal(usage.turnCount, 3);
  assert.equal(usage.modelCallCount, 5);
});

test('ConversationUsageTracker.snapshot returns serializable data', () => {
  const tracker = new ConversationUsageTracker('conv-1');
  tracker.addRecord(makeRecord({ estimatedCostUsd: 0.01 }));
  tracker.incrementTurnCount();

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.conversationId, 'conv-1');
  assert.equal(snapshot.totalEstimatedCostUsd, 0.01);
  assert.equal(snapshot.turnCount, 1);
  assert.equal(snapshot.modelCallCount, 1);
});

test('ConversationUsageTracker preserves creatorId', () => {
  const tracker = new ConversationUsageTracker('conv-1', 'creator-42');
  assert.equal(tracker.getUsage().creatorId, 'creator-42');
});
