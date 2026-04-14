import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareContextForModelCall } from './prepareContextForModelCall.js';
import { TokenBudget } from './TokenBudget.js';
import { Microcompact } from './Microcompact.js';
import { generateId, type Message } from '../../models/ModelClient.js';
import type { ToolResultPersistenceConfig } from './types.js';

// Minimal stub that never persists (budget never exceeded in these tests)
const stubPersistence = {
  async processResult(_tn: string, _tc: string, content: string) { return content; },
  async enforceMessageBudget(messages: Message[]) { return messages; },
  async cleanup() {},
} as unknown as import('./ToolResultPersistence.js').ToolResultPersistence;

function makeDeps(overrides?: { microcompactGapMinutes?: number }) {
  return {
    tokenBudget: new TokenBudget({
      modelMetadata: { 'test-model': { contextWindowSize: 10000, maxOutputTokens: 1000 } },
      defaultContextWindowSize: 10000,
      defaultMaxOutputTokens: 1000,
      microcompactRatio: 0.5,
      projectionRatio: 0.7,
      overflowRatio: 0.9,
      safetyMargin: 1.0,
    }),
    toolResultPersistence: stubPersistence,
    microcompact: new Microcompact({
      gapThresholdMinutes: overrides?.microcompactGapMinutes ?? 60,
      keepRecentResults: 1,
      compactableTools: new Set(['web_search']),
      clearedMarker: '[CLEARED]',
    }),
  };
}

test('pipeline returns messages unchanged when nothing to compact', async () => {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.', id: generateId() },
    { role: 'user', content: 'hello', id: generateId() },
  ];
  const result = await prepareContextForModelCall(messages, 'test-model', undefined, 'conv-1', makeDeps());
  assert.equal(result.rewrote, false);
  assert.equal(result.pressure, 'nominal');
  assert.equal(result.messages.length, 2);
});

test('pipeline clears stale tool results and invalidates baseline', async () => {
  const oldTs = new Date(Date.now() - 120 * 60_000).toISOString();
  const messages: Message[] = [
    { role: 'user', content: 'search', id: generateId() },
    { role: 'assistant', content: null, timestamp: oldTs, id: generateId() },
    { role: 'tool', content: 'old result 1', toolCallId: 'c1', toolName: 'web_search', id: generateId() },
    { role: 'tool', content: 'old result 2', toolCallId: 'c2', toolName: 'web_search', id: generateId() },
  ];
  const deps = makeDeps();
  const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
  const result = await prepareContextForModelCall(messages, 'test-model', usage, 'conv-1', deps);

  assert.equal(result.rewrote, true);
  // One of the two tool results should be cleared (keepRecentResults=1)
  const cleared = result.messages.filter((m) => m.content === '[CLEARED]');
  assert.equal(cleared.length, 1);
});

test('pipeline detects overflow pressure', async () => {
  // effective window = 10000 - 1000 = 9000. overflow at 0.9 = 8100
  // With safety=1.0, need >8100 tokens = >32400 chars
  const bigContent = 'x'.repeat(40000);
  const messages: Message[] = [
    { role: 'user', content: bigContent, id: generateId() },
  ];
  const result = await prepareContextForModelCall(messages, 'test-model', undefined, 'conv-1', makeDeps());
  assert.equal(result.pressure, 'overflow');
});

test('pipeline returns zero compaction stats when no compaction runs', async () => {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.', id: generateId() },
    { role: 'user', content: 'hello', id: generateId() },
  ];
  const result = await prepareContextForModelCall(messages, 'test-model', undefined, 'conv-1', makeDeps());
  assert.equal(result.messagesRemoved, 0);
  assert.equal(result.tokensSaved, 0);
  assert.equal(result.compactionType, undefined);
});

test('pipeline returns microcompact stats when microcompact runs', async () => {
  const oldTs = new Date(Date.now() - 120 * 60_000).toISOString();
  const messages: Message[] = [
    { role: 'user', content: 'search', id: generateId() },
    { role: 'assistant', content: null, timestamp: oldTs, id: generateId() },
    { role: 'tool', content: 'old result 1', toolCallId: 'c1', toolName: 'web_search', id: generateId() },
    { role: 'tool', content: 'old result 2', toolCallId: 'c2', toolName: 'web_search', id: generateId() },
  ];
  const result = await prepareContextForModelCall(messages, 'test-model', undefined, 'conv-1', makeDeps());
  assert.equal(result.compactionType, 'microcompact');
  assert.ok(result.tokensSaved >= 0);
  // messagesRemoved can be 0 since microcompact replaces content but may not remove messages
});

test('pipeline runs on every call (idempotent when nothing to compact)', async () => {
  const messages: Message[] = [
    { role: 'user', content: 'hi', id: generateId() },
  ];
  const deps = makeDeps();
  const r1 = await prepareContextForModelCall(messages, 'test-model', undefined, 'conv-1', deps);
  const r2 = await prepareContextForModelCall(r1.messages, 'test-model', undefined, 'conv-1', deps);
  assert.equal(r1.rewrote, false);
  assert.equal(r2.rewrote, false);
  assert.deepEqual(r1.messages, r2.messages);
});

// --- Track 02: Steps 4-5 pipeline extension tests ---

test('pipeline triggers session memory compaction on projection pressure', async () => {
  const compactedMsgs: Message[] = [
    { role: 'assistant', content: '[compacted]', id: generateId(), synthetic: true },
    { role: 'user', content: 'recent message', id: generateId() },
  ];

  const tinyBudget = new TokenBudget({
    modelMetadata: {},
    defaultContextWindowSize: 100,
    defaultMaxOutputTokens: 20,
    microcompactRatio: 0.1,
    projectionRatio: 0.2,
    overflowRatio: 0.9,
    safetyMargin: 1.33,
  });

  const deps = {
    ...makeDeps(),
    tokenBudget: tinyBudget,
    sessionMemoryCompact: {
      tryCompact: async () => ({
        messages: compactedMsgs,
        preCompactTokens: 400,
        postCompactTokens: 200,
      }),
    } as any,
  };

  // Create messages that exceed the tiny context window
  const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'a'.repeat(50),
    id: generateId(),
  }));

  const result = await prepareContextForModelCall(messages, 'test-model', undefined, 'conv-1', deps);

  assert.equal(result.compactionType, 'projection');
  assert.equal(result.rewrote, true);
  assert.ok(result.tokensSaved > 0);
});

test('pipeline does not invoke session memory compact on nominal pressure', async () => {
  let compactCalled = false;
  const deps = {
    ...makeDeps(),
    sessionMemoryCompact: {
      tryCompact: async () => {
        compactCalled = true;
        return null;
      },
    } as any,
  };

  const messages: Message[] = [
    { role: 'user', content: 'hi', id: generateId() },
  ];
  await prepareContextForModelCall(messages, 'test-model', undefined, 'conv-1', deps);
  assert.equal(compactCalled, false, 'Session memory compact should not be called on nominal pressure');
});
