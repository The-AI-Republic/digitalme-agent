import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { ToolResultPersistence } from './ToolResultPersistence.js';
import { generateId } from '../../models/ModelClient.js';
import type { ToolResultPersistenceConfig } from './types.js';

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trp-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeConfig(storageDir: string, overrides?: Partial<ToolResultPersistenceConfig>): ToolResultPersistenceConfig {
  return {
    defaultMaxResultChars: 100,
    perMessageBudgetChars: 300,
    previewSizeBytes: 20,
    storageDir,
    ...overrides,
  };
}

test('processResult returns content unchanged when under threshold', async () => {
  await withTempDir(async (dir) => {
    const trp = new ToolResultPersistence(makeConfig(dir));
    const result = await trp.processResult('search', 'call_1', 'short content', 'conv-1');
    assert.equal(result, 'short content');
  });
});

test('processResult persists oversized content and returns preview stub', async () => {
  await withTempDir(async (dir) => {
    const trp = new ToolResultPersistence(makeConfig(dir));
    const bigContent = 'x'.repeat(200);
    const result = await trp.processResult('search', 'call_1', bigContent, 'conv-1');

    assert.ok(result.includes('<persisted-output>'));
    assert.ok(result.includes('Output too large'));
    assert.ok(result.includes('</persisted-output>'));

    // Verify file was written
    const filePath = path.join(dir, 'conv-1', 'tool-results', 'call_1.txt');
    const saved = await fs.readFile(filePath, 'utf-8');
    assert.equal(saved, bigContent);
  });
});

test('processResult respects per-tool thresholds', async () => {
  await withTempDir(async (dir) => {
    const trp = new ToolResultPersistence(makeConfig(dir, {
      perToolThresholds: { 'web_search': 50 },
    }));
    // 60 chars — under default (100) but over web_search (50)
    const content = 'y'.repeat(60);
    const result = await trp.processResult('web_search', 'call_1', content, 'conv-1');
    assert.ok(result.includes('<persisted-output>'));
  });
});

test('processResult returns original on persistence failure', async () => {
  // Use a read-only file as storage dir to force write failure
  const trp = new ToolResultPersistence(makeConfig('/dev/null/impossible'));
  const bigContent = 'z'.repeat(200);
  const result = await trp.processResult('search', 'call_1', bigContent, 'conv-1');
  assert.equal(result, bigContent);
});

test('enforceMessageBudget does nothing when under budget', async () => {
  await withTempDir(async (dir) => {
    const trp = new ToolResultPersistence(makeConfig(dir));
    const messages = [
      { role: 'tool' as const, content: 'small', toolCallId: 'c1', toolName: 'search', id: generateId() },
    ];
    const result = await trp.enforceMessageBudget(messages, 'conv-1');
    assert.equal(result[0].content, 'small');
  });
});

test('enforceMessageBudget persists largest tool results first', async () => {
  await withTempDir(async (dir) => {
    const trp = new ToolResultPersistence(makeConfig(dir, {
      defaultMaxResultChars: 50,
      perMessageBudgetChars: 200,
    }));
    const messages = [
      { role: 'user' as const, content: 'hi', id: generateId() },
      { role: 'tool' as const, content: 'a'.repeat(80), toolCallId: 'c1', toolName: 'search', id: generateId() },
      { role: 'tool' as const, content: 'b'.repeat(150), toolCallId: 'c2', toolName: 'search', id: generateId() },
    ];
    // Total tool content = 230, budget = 200. Largest (150) gets persisted first.
    const result = await trp.enforceMessageBudget(messages, 'conv-1');
    assert.equal(result[0].content, 'hi'); // non-tool unchanged
    assert.ok(result[2].content!.includes('<persisted-output>')); // largest persisted
  });
});

test('cleanup removes conversation directory', async () => {
  await withTempDir(async (dir) => {
    const trp = new ToolResultPersistence(makeConfig(dir));
    // Create a file first
    const bigContent = 'z'.repeat(200);
    await trp.processResult('search', 'call_1', bigContent, 'conv-1');
    // Verify it exists
    const filePath = path.join(dir, 'conv-1', 'tool-results', 'call_1.txt');
    await fs.access(filePath);
    // Clean up
    await trp.cleanup('conv-1');
    // Verify directory is gone
    await assert.rejects(fs.access(path.join(dir, 'conv-1')));
  });
});
