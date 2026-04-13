import test from 'node:test';
import assert from 'node:assert/strict';

import { QuotaEnforcer } from './QuotaEnforcer.js';
import type { ConversationUsage, QuotaWarningEvent } from './types.js';

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

// --- Cost per conversation ---

test('QuotaEnforcer allows when under cost limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
  });
  const result = enforcer.checkConversation(makeUsage({ totalEstimatedCostUsd: 0.5 }));
  assert.equal(result.allowed, true);
});

test('QuotaEnforcer refuses when over cost limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
  });
  const result = enforcer.checkConversation(makeUsage({ totalEstimatedCostUsd: 1.5 }));
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('cost_per_conversation'));
  assert.equal(result.remainingBudget, 0);
});

test('QuotaEnforcer refuses when exactly at cost limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
  });
  const result = enforcer.checkConversation(makeUsage({ totalEstimatedCostUsd: 1.0 }));
  assert.equal(result.allowed, false);
});

// --- Tokens per conversation ---

test('QuotaEnforcer allows when under token limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxTokensPerConversation: 100000 },
  });
  const result = enforcer.checkConversation(makeUsage({ totalInputTokens: 30000, totalOutputTokens: 20000 }));
  assert.equal(result.allowed, true);
});

test('QuotaEnforcer refuses when over token limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxTokensPerConversation: 100000 },
  });
  const result = enforcer.checkConversation(makeUsage({ totalInputTokens: 60000, totalOutputTokens: 50000 }));
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('tokens_per_conversation'));
});

// --- Turns per conversation ---

test('QuotaEnforcer allows when under turn limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxTurnsPerConversation: 10 },
  });
  const result = enforcer.checkConversation(makeUsage({ turnCount: 5 }));
  assert.equal(result.allowed, true);
});

test('QuotaEnforcer refuses when over turn limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxTurnsPerConversation: 10 },
  });
  const result = enforcer.checkConversation(makeUsage({ turnCount: 10 }));
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('turns_per_conversation'));
});

// --- Daily quota ---

test('QuotaEnforcer.checkDaily allows when under daily limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerDay: 10.0 },
  });
  const result = enforcer.checkDaily(5.0);
  assert.equal(result.allowed, true);
});

test('QuotaEnforcer.checkDaily refuses when over daily limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerDay: 10.0 },
  });
  const result = enforcer.checkDaily(15.0);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('cost_per_day'));
});

test('QuotaEnforcer.checkDaily allows when no daily limit set', () => {
  const enforcer = new QuotaEnforcer({
    quota: {},
  });
  const result = enforcer.checkDaily(999.0);
  assert.equal(result.allowed, true);
});

// --- Monthly quota ---

test('QuotaEnforcer.checkMonthly allows when under monthly limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerMonth: 100.0 },
  });
  const result = enforcer.checkMonthly(50.0);
  assert.equal(result.allowed, true);
});

test('QuotaEnforcer.checkMonthly refuses when over monthly limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerMonth: 100.0 },
  });
  const result = enforcer.checkMonthly(150.0);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('cost_per_month'));
});

// --- checkAll ---

test('QuotaEnforcer.checkAll returns first failure', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0, maxCostPerDay: 10.0 },
  });
  const result = enforcer.checkAll(makeUsage({ totalEstimatedCostUsd: 2.0 }), 5.0);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('cost_per_conversation'));
});

test('QuotaEnforcer.checkAll checks daily even if conversation is ok', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 10.0, maxCostPerDay: 5.0 },
  });
  const result = enforcer.checkAll(makeUsage({ totalEstimatedCostUsd: 1.0 }), 6.0);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('cost_per_day'));
});

test('QuotaEnforcer.checkAll returns allowed when all checks pass', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 10.0, maxCostPerDay: 50.0, maxCostPerMonth: 500.0 },
  });
  const result = enforcer.checkAll(makeUsage({ totalEstimatedCostUsd: 1.0 }), 5.0, 50.0);
  assert.equal(result.allowed, true);
});

// --- Warning events ---

test('QuotaEnforcer emits warning when approaching cost limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
    warningThreshold: 0.8,
  });
  const warnings: QuotaWarningEvent[] = [];
  enforcer.onWarning((w) => warnings.push(w));

  enforcer.checkConversation(makeUsage({ totalEstimatedCostUsd: 0.85 }));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.quotaType, 'cost_per_conversation');
  assert.equal(warnings[0]!.percentUsed, 85);
});

test('QuotaEnforcer does not emit warning when well below threshold', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
    warningThreshold: 0.8,
  });
  const warnings: QuotaWarningEvent[] = [];
  enforcer.onWarning((w) => warnings.push(w));

  enforcer.checkConversation(makeUsage({ totalEstimatedCostUsd: 0.5 }));
  assert.equal(warnings.length, 0);
});

test('QuotaEnforcer does not emit warning when exceeded (only when approaching)', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
    warningThreshold: 0.8,
  });
  const warnings: QuotaWarningEvent[] = [];
  enforcer.onWarning((w) => warnings.push(w));

  enforcer.checkConversation(makeUsage({ totalEstimatedCostUsd: 1.5 }));
  assert.equal(warnings.length, 0);
});

// --- shouldDowngradeModel ---

test('QuotaEnforcer.shouldDowngradeModel returns true when approaching and configured', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
    warningThreshold: 0.8,
    onExceeded: 'downgrade_model',
  });
  const result = enforcer.shouldDowngradeModel(makeUsage({ totalEstimatedCostUsd: 0.85 }));
  assert.equal(result, true);
});

test('QuotaEnforcer.shouldDowngradeModel returns false when not configured for downgrade', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
    warningThreshold: 0.8,
    onExceeded: 'graceful_refuse',
  });
  const result = enforcer.shouldDowngradeModel(makeUsage({ totalEstimatedCostUsd: 0.85 }));
  assert.equal(result, false);
});

test('QuotaEnforcer.shouldDowngradeModel returns false when well below threshold', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
    warningThreshold: 0.8,
    onExceeded: 'downgrade_model',
  });
  const result = enforcer.shouldDowngradeModel(makeUsage({ totalEstimatedCostUsd: 0.3 }));
  assert.equal(result, false);
});

// --- Configuration ---

test('QuotaEnforcer uses custom refusal message', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
    refusalMessage: 'Custom refusal',
  });
  assert.equal(enforcer.getRefusalMessage(), 'Custom refusal');
});

test('QuotaEnforcer uses default refusal message', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
  });
  assert.ok(enforcer.getRefusalMessage().includes('usage limit'));
});

test('QuotaEnforcer.getQuota returns a copy of the quota', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0, maxCostPerDay: 10.0 },
  });
  const quota = enforcer.getQuota();
  assert.equal(quota.maxCostPerConversation, 1.0);
  assert.equal(quota.maxCostPerDay, 10.0);
});

test('QuotaEnforcer with no quotas allows everything', () => {
  const enforcer = new QuotaEnforcer({ quota: {} });
  const result = enforcer.checkConversation(makeUsage({ totalEstimatedCostUsd: 999 }));
  assert.equal(result.allowed, true);
});

// --- suggestedAction ---

test('QuotaEnforcer returns proceed when well under limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
    warningThreshold: 0.8,
  });
  const result = enforcer.checkConversation(makeUsage({ totalEstimatedCostUsd: 0.3 }));
  assert.equal(result.suggestedAction, 'proceed');
});

test('QuotaEnforcer returns downgrade_model when approaching limit', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
    warningThreshold: 0.8,
  });
  const result = enforcer.checkConversation(makeUsage({ totalEstimatedCostUsd: 0.85 }));
  assert.equal(result.suggestedAction, 'downgrade_model');
});

test('QuotaEnforcer returns refuse when exceeded', () => {
  const enforcer = new QuotaEnforcer({
    quota: { maxCostPerConversation: 1.0 },
    onExceeded: 'graceful_refuse',
  });
  const result = enforcer.checkConversation(makeUsage({ totalEstimatedCostUsd: 1.5 }));
  assert.equal(result.suggestedAction, 'refuse');
});
