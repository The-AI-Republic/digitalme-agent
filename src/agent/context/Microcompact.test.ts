import test from 'node:test';
import assert from 'node:assert/strict';

import { Microcompact } from './Microcompact.js';
import type { Message } from '../../models/ModelClient.js';
import type { MicrocompactConfig } from './types.js';

function makeConfig(overrides?: Partial<MicrocompactConfig>): MicrocompactConfig {
  return {
    gapThresholdMinutes: 60,
    keepRecentResults: 2,
    compactableTools: new Set(['web_search']),
    clearedMarker: '[CLEARED]',
    ...overrides,
  };
}

function oldTimestamp(): string {
  return new Date(Date.now() - 120 * 60_000).toISOString(); // 2 hours ago
}

function recentTimestamp(): string {
  return new Date(Date.now() - 5 * 60_000).toISOString(); // 5 minutes ago
}

test('no-op when last assistant message is recent', () => {
  const mc = new Microcompact(makeConfig());
  const messages: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello', timestamp: recentTimestamp() },
    { role: 'tool', content: 'old result', toolCallId: 'c1', toolName: 'web_search' },
  ];
  const result = mc.compact(messages);
  assert.equal(result.resultsCleared, 0);
  assert.equal(result.tokensFreed, 0);
  assert.equal(result.messages[2].content, 'old result');
});

test('no-op when last assistant message has no timestamp', () => {
  const mc = new Microcompact(makeConfig());
  const messages: Message[] = [
    { role: 'assistant', content: 'hello' },
    { role: 'tool', content: 'result', toolCallId: 'c1', toolName: 'web_search' },
  ];
  const result = mc.compact(messages);
  assert.equal(result.resultsCleared, 0);
});

test('clears old compactable tool results beyond keepRecentResults', () => {
  const mc = new Microcompact(makeConfig({ keepRecentResults: 1 }));
  const messages: Message[] = [
    { role: 'user', content: 'search' },
    { role: 'assistant', content: null, timestamp: oldTimestamp() },
    { role: 'tool', content: 'oldest result', toolCallId: 'c1', toolName: 'web_search' },
    { role: 'tool', content: 'middle result', toolCallId: 'c2', toolName: 'web_search' },
    { role: 'tool', content: 'newest result', toolCallId: 'c3', toolName: 'web_search' },
  ];
  const result = mc.compact(messages);
  // keepRecentResults=1: newest kept, middle and oldest cleared
  assert.equal(result.resultsCleared, 2);
  assert.equal(result.messages[2].content, '[CLEARED]');
  assert.equal(result.messages[3].content, '[CLEARED]');
  assert.equal(result.messages[4].content, 'newest result');
});

test('does not clear non-compactable tool results', () => {
  const mc = new Microcompact(makeConfig({ keepRecentResults: 0 }));
  const messages: Message[] = [
    { role: 'assistant', content: null, timestamp: oldTimestamp() },
    { role: 'tool', content: 'custom result', toolCallId: 'c1', toolName: 'custom_tool' },
    { role: 'tool', content: 'search result', toolCallId: 'c2', toolName: 'web_search' },
  ];
  const result = mc.compact(messages);
  assert.equal(result.messages[1].content, 'custom result'); // non-compactable preserved
  assert.equal(result.messages[2].content, '[CLEARED]'); // compactable cleared
  assert.equal(result.resultsCleared, 1);
});

test('preserves non-tool messages', () => {
  const mc = new Microcompact(makeConfig({ keepRecentResults: 0 }));
  const messages: Message[] = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'thinking...', timestamp: oldTimestamp() },
    { role: 'tool', content: 'result', toolCallId: 'c1', toolName: 'web_search' },
    { role: 'user', content: 'follow up' },
  ];
  const result = mc.compact(messages);
  assert.equal(result.messages[0].content, 'question');
  assert.equal(result.messages[1].content, 'thinking...');
  assert.equal(result.messages[2].content, '[CLEARED]');
  assert.equal(result.messages[3].content, 'follow up');
});

test('tokensFreed is estimated correctly', () => {
  const mc = new Microcompact(makeConfig({ keepRecentResults: 0 }));
  const messages: Message[] = [
    { role: 'assistant', content: null, timestamp: oldTimestamp() },
    { role: 'tool', content: 'a'.repeat(400), toolCallId: 'c1', toolName: 'web_search' },
  ];
  const result = mc.compact(messages);
  // 400 chars original - 9 chars marker = 391 freed chars / 4 = 97.75 -> 98 tokens
  assert.ok(result.tokensFreed > 90);
});
