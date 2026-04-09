import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { SessionMemoryCompact } from './SessionMemoryCompact.js';
import { SessionMemory } from './SessionMemory.js';
import { TokenBudget } from './TokenBudget.js';
import type { Message } from '../../models/ModelClient.js';

const tokenBudget = new TokenBudget({
  modelMetadata: {},
  defaultContextWindowSize: 128000,
  defaultMaxOutputTokens: 4096,
  microcompactRatio: 0.5,
  projectionRatio: 0.7,
  overflowRatio: 0.9,
  safetyMargin: 1.0,
});

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smc-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('tryCompact returns null when no session memory exists', async () => {
  const sm = new SessionMemory({
    enabled: true, tokensBetweenUpdates: 5000, toolCallsBetweenUpdates: 3,
    minimumTokensToInit: 10000, maxTotalTokens: 8000, maxSectionTokens: 1500,
    storagePath: '/tmp/nonexistent/sm.md',
  });
  const smc = new SessionMemoryCompact({ minTokens: 100, minTextBlockMessages: 2, maxTokens: 5000 }, sm, tokenBudget);
  const result = await smc.tryCompact([], 'test');
  assert.equal(result, null);
});

test('tryCompact returns compacted messages when memory exists', async () => {
  await withTempDir(async (dir) => {
    const storagePath = path.join(dir, 'sm.md');
    const sm = new SessionMemory({
      enabled: true, tokensBetweenUpdates: 5000, toolCallsBetweenUpdates: 3,
      minimumTokensToInit: 10000, maxTotalTokens: 8000, maxSectionTokens: 1500,
      storagePath,
    });
    await sm.completeExtraction('# Session Memory\nFan likes cats.');

    const messages: Message[] = [
      { role: 'user', content: 'hello', id: 'msg-1' },
      { role: 'assistant', content: 'hi there', id: 'msg-2' },
      { role: 'user', content: 'tell me about cats', id: 'msg-3' },
      { role: 'assistant', content: 'cats are great', id: 'msg-4' },
      { role: 'user', content: 'more please', id: 'msg-5' },
    ];

    const smc = new SessionMemoryCompact({ minTokens: 0, minTextBlockMessages: 2, maxTokens: 50000 }, sm, tokenBudget);
    const result = await smc.tryCompact(messages, 'test');

    assert.ok(result);
    assert.ok(result.messages.length > 0);
    assert.ok(result.messages[0].content!.includes('Session Memory'));
    assert.ok(result.preCompactTokens > 0);
  });
});

test('tryCompact preserves assistant-tool groups', async () => {
  await withTempDir(async (dir) => {
    const storagePath = path.join(dir, 'sm.md');
    const sm = new SessionMemory({
      enabled: true, tokensBetweenUpdates: 5000, toolCallsBetweenUpdates: 3,
      minimumTokensToInit: 10000, maxTotalTokens: 8000, maxSectionTokens: 1500,
      storagePath,
    });
    await sm.completeExtraction('# Memory\nSome notes.');

    const messages: Message[] = [
      { role: 'user', content: 'search', id: 'msg-1' },
      {
        role: 'assistant', content: null, id: 'msg-2',
        toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', content: 'result', toolCallId: 'call_1', toolName: 'search', id: 'msg-3' },
      { role: 'assistant', content: 'here are results', id: 'msg-4' },
    ];

    const smc = new SessionMemoryCompact({ minTokens: 0, minTextBlockMessages: 1, maxTokens: 50000 }, sm, tokenBudget);
    const result = await smc.tryCompact(messages, 'test');

    assert.ok(result);
    // Should never have an orphaned tool result without its assistant message
    for (let i = 0; i < result.messages.length; i++) {
      const msg = result.messages[i];
      if (msg.role === 'tool' && msg.toolCallId) {
        // There should be a preceding assistant with matching toolCalls
        const preceding = result.messages.slice(0, i).find(
          (m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === msg.toolCallId),
        );
        assert.ok(preceding, `Tool result ${msg.toolCallId} has no matching assistant message`);
      }
    }
  });
});
