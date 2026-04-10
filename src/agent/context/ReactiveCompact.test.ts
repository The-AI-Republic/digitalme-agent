import test from 'node:test';
import assert from 'node:assert/strict';

import { ReactiveCompact } from './ReactiveCompact.js';
import { PostCompactRecovery } from './PostCompactRecovery.js';
import { generateId, type Message } from '../../models/ModelClient.js';
import type { ConversationSummary } from './types.js';

const fakeBuilder = {
  async summarize(messages: Message[], cutoff: number): Promise<ConversationSummary> {
    return {
      text: `Summary of ${cutoff} messages`,
      coversMessageCount: cutoff,
      generatedAt: Date.now(),
      estimatedTokens: 50,
    };
  },
} as import('./ConversationSummaryBuilder.js').ConversationSummaryBuilder;

const recovery = new PostCompactRecovery({ maxRecoveryTokens: 10000 });

test('canAttempt is true initially', () => {
  const rc = new ReactiveCompact({ maxRetries: 1, aggressivePreserveMessages: 2 }, fakeBuilder, recovery);
  assert.equal(rc.canAttempt(), true);
});

test('canAttempt is false after one attempt', async () => {
  const rc = new ReactiveCompact({ maxRetries: 1, aggressivePreserveMessages: 2 }, fakeBuilder, recovery);
  const messages: Message[] = [
    { role: 'user', content: 'a', id: generateId() },
    { role: 'assistant', content: 'b', id: generateId() },
    { role: 'user', content: 'c', id: generateId() },
    { role: 'assistant', content: 'd', id: generateId() },
  ];
  await rc.recover(messages, {});
  assert.equal(rc.canAttempt(), false);
});

test('resetForNewTurn re-enables attempt', async () => {
  const rc = new ReactiveCompact({ maxRetries: 1, aggressivePreserveMessages: 2 }, fakeBuilder, recovery);
  await rc.recover([{ role: 'user', content: 'x', id: generateId() }], {});
  assert.equal(rc.canAttempt(), false);
  rc.resetForNewTurn();
  assert.equal(rc.canAttempt(), true);
});

test('recover preserves last N messages and prepends summary', async () => {
  const rc = new ReactiveCompact({ maxRetries: 1, aggressivePreserveMessages: 2 }, fakeBuilder, recovery);
  const messages: Message[] = [
    { role: 'user', content: 'old', id: generateId() },
    { role: 'assistant', content: 'old reply', id: generateId() },
    { role: 'user', content: 'recent', id: generateId() },
    { role: 'assistant', content: 'recent reply', id: generateId() },
  ];
  const result = await rc.recover(messages, {});
  assert.ok(result.succeeded);
  // First message should be the compaction summary
  assert.ok(result.messages[0].content!.includes('Emergency compaction'));
  assert.ok(result.messages[0].content!.includes('Summary of 2 messages'));
  // Last 2 original messages preserved
  assert.equal(result.messages[result.messages.length - 1].content, 'recent reply');
  assert.equal(result.messages[result.messages.length - 2].content, 'recent');
});
