import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { SessionMemory } from './SessionMemory.js';
import { SESSION_MEMORY_TEMPLATE } from './SessionMemoryPrompt.js';

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeConfig(storagePath: string) {
  return {
    enabled: true,
    tokensBetweenUpdates: 5000,
    toolCallsBetweenUpdates: 3,
    minimumTokensToInit: 10000,
    maxTotalTokens: 8000,
    maxSectionTokens: 1500,
    storagePath,
  };
}

test('shouldExtract returns false when below init threshold', () => {
  const sm = new SessionMemory(makeConfig('/tmp/test-sm.md'));
  assert.equal(sm.shouldExtract(5000), false);
});

test('shouldExtract returns false when token growth is insufficient after first extraction', () => {
  const sm = new SessionMemory(makeConfig('/tmp/test-sm.md'));
  sm.incrementToolCalls(5);
  // First extraction triggers at 15001
  assert.equal(sm.shouldExtract(15001), true);
  // Simulate extraction happened
  sm.startExtraction(15001, 'msg-1');
  sm.incrementToolCalls(5);
  // Only 100 tokens of growth — not enough
  assert.equal(sm.shouldExtract(15101), false);
});

test('shouldExtract returns true when thresholds are met', () => {
  const sm = new SessionMemory(makeConfig('/tmp/test-sm.md'));
  sm.incrementToolCalls(5);
  // First extraction: init at 10000 + enough growth + tool calls
  assert.equal(sm.shouldExtract(15001), true);
});

test('shouldExtract returns false when tool calls insufficient', () => {
  const sm = new SessionMemory({
    ...makeConfig('/tmp/test-sm.md'),
    toolCallsBetweenUpdates: 5,
  });
  sm.incrementToolCalls(2);
  assert.equal(sm.shouldExtract(20000), false);
});

test('completeExtraction writes file and getMemory reads it', async () => {
  await withTempDir(async (dir) => {
    const storagePath = path.join(dir, 'conv-1', 'session-memory.md');
    const sm = new SessionMemory(makeConfig(storagePath));
    const notes = '# Conversation Title\nTest conversation about cats';
    await sm.completeExtraction(notes);

    const memory = await sm.getMemory();
    assert.ok(memory);
    assert.equal(memory.text, notes);
    assert.ok(memory.estimatedTokens > 0);
  });
});

test('getMemory returns undefined when file does not exist', async () => {
  const sm = new SessionMemory(makeConfig('/tmp/nonexistent/path/sm.md'));
  const memory = await sm.getMemory();
  assert.equal(memory, undefined);
});

test('getMemory returns undefined when file contains only the bare template', async () => {
  await withTempDir(async (dir) => {
    const storagePath = path.join(dir, 'session-memory.md');
    await fs.writeFile(storagePath, SESSION_MEMORY_TEMPLATE, 'utf-8');
    const sm = new SessionMemory(makeConfig(storagePath));
    const memory = await sm.getMemory();
    assert.equal(memory, undefined);
  });
});

test('clear resets state and deletes file', async () => {
  await withTempDir(async (dir) => {
    const storagePath = path.join(dir, 'session-memory.md');
    const sm = new SessionMemory(makeConfig(storagePath));
    await sm.completeExtraction('some notes');
    await sm.clear();

    const memory = await sm.getMemory();
    assert.equal(memory, undefined);
    assert.equal(sm.shouldExtract(20000), false); // state reset
  });
});

test('startExtraction updates tracking state', () => {
  const sm = new SessionMemory(makeConfig('/tmp/test-sm.md'));
  sm.incrementToolCalls(10);
  sm.startExtraction(15000, 'msg-123');
  assert.equal(sm.getLastSummarizedMessageId(), 'msg-123');
  // After starting, tool calls reset, so shouldExtract should be false
  assert.equal(sm.shouldExtract(15000), false);
});
