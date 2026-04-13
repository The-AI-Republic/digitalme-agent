import test from 'node:test';
import assert from 'node:assert/strict';

import { CostAwareRouter } from './CostAwareRouter.js';
import type { ConversationUsage } from './types.js';

function makeUsage(overrides?: Partial<ConversationUsage>): ConversationUsage {
  return {
    conversationId: 'conv-1',
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    turnCount: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    mainConversationCost: 0,
    backgroundWorkCost: 0,
    costByModel: {},
    ...overrides,
  };
}

test('CostAwareRouter with no quota config allows everything', () => {
  const router = new CostAwareRouter({});
  const decision = router.evaluate(makeUsage({ totalEstimatedCostUsd: 999 }));
  assert.equal(decision.allowed, true);
  assert.equal(decision.useFallbackModel, false);
  assert.equal(decision.increaseCompaction, false);
});

test('CostAwareRouter allows when under quota', () => {
  const router = new CostAwareRouter({
    quotaConfig: {
      quota: { maxCostPerConversation: 1.0 },
    },
  });
  const decision = router.evaluate(makeUsage({ totalEstimatedCostUsd: 0.3 }));
  assert.equal(decision.allowed, true);
  assert.equal(decision.useFallbackModel, false);
  assert.equal(decision.increaseCompaction, false);
});

test('CostAwareRouter refuses when over quota', () => {
  const router = new CostAwareRouter({
    quotaConfig: {
      quota: { maxCostPerConversation: 1.0 },
    },
  });
  const decision = router.evaluate(makeUsage({ totalEstimatedCostUsd: 1.5 }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.refusalMessage);
});

test('CostAwareRouter signals fallback model when approaching limit', () => {
  const router = new CostAwareRouter({
    quotaConfig: {
      quota: { maxCostPerConversation: 1.0 },
    },
    fallbackThreshold: 0.7,
  });
  const decision = router.evaluate(makeUsage({ totalEstimatedCostUsd: 0.75 }));
  assert.equal(decision.allowed, true);
  assert.equal(decision.useFallbackModel, true);
});

test('CostAwareRouter signals increased compaction at compaction threshold', () => {
  const router = new CostAwareRouter({
    quotaConfig: {
      quota: { maxCostPerConversation: 1.0 },
    },
    compactionThreshold: 0.5,
  });
  const decision = router.evaluate(makeUsage({ totalEstimatedCostUsd: 0.55 }));
  assert.equal(decision.allowed, true);
  assert.equal(decision.increaseCompaction, true);
});

test('CostAwareRouter does not signal fallback when below fallback threshold', () => {
  const router = new CostAwareRouter({
    quotaConfig: {
      quota: { maxCostPerConversation: 1.0 },
    },
    fallbackThreshold: 0.7,
  });
  const decision = router.evaluate(makeUsage({ totalEstimatedCostUsd: 0.5 }));
  assert.equal(decision.allowed, true);
  assert.equal(decision.useFallbackModel, false);
});

test('CostAwareRouter checks daily quota', () => {
  const router = new CostAwareRouter({
    quotaConfig: {
      quota: { maxCostPerDay: 10.0 },
    },
  });
  const decision = router.evaluate(makeUsage(), 15.0);
  assert.equal(decision.allowed, false);
});

test('CostAwareRouter checks monthly quota', () => {
  const router = new CostAwareRouter({
    quotaConfig: {
      quota: { maxCostPerMonth: 100.0 },
    },
  });
  const decision = router.evaluate(makeUsage(), undefined, 150.0);
  assert.equal(decision.allowed, false);
});

test('CostAwareRouter.getEnforcer returns enforcer when configured', () => {
  const router = new CostAwareRouter({
    quotaConfig: { quota: { maxCostPerConversation: 1.0 } },
  });
  assert.ok(router.getEnforcer());
});

test('CostAwareRouter.getEnforcer returns undefined when no quota config', () => {
  const router = new CostAwareRouter({});
  assert.equal(router.getEnforcer(), undefined);
});

test('CostAwareRouter uses custom refusal message', () => {
  const router = new CostAwareRouter({
    quotaConfig: {
      quota: { maxCostPerConversation: 1.0 },
      refusalMessage: 'Too expensive!',
    },
  });
  const decision = router.evaluate(makeUsage({ totalEstimatedCostUsd: 1.5 }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusalMessage, 'Too expensive!');
});
