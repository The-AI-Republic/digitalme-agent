/**
 * Tests for UsagePersistence (Track 11: usage data persistence).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { UsagePersistence } from './UsagePersistence.js';
import type { ConversationUsage } from './types.js';

function makeUsage(conversationId: string): ConversationUsage {
  return {
    conversationId,
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
  };
}

test('UsagePersistence save and load round-trips', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
  try {
    const persistence = new UsagePersistence(dir);
    const usage = makeUsage('conv-1');

    await persistence.save(usage);
    const loaded = await persistence.load('conv-1');

    assert.ok(loaded);
    assert.equal(loaded!.conversationId, 'conv-1');
    assert.equal(loaded!.totalInputTokens, 100);
    assert.equal(loaded!.totalEstimatedCostUsd, 0.001);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('UsagePersistence load returns undefined for missing conversation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
  try {
    const persistence = new UsagePersistence(dir);
    const loaded = await persistence.load('nonexistent');
    assert.equal(loaded, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('UsagePersistence remove deletes persisted data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
  try {
    const persistence = new UsagePersistence(dir);
    await persistence.save(makeUsage('conv-1'));
    await persistence.remove('conv-1');
    const loaded = await persistence.load('conv-1');
    assert.equal(loaded, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('UsagePersistence remove does not throw for missing file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
  try {
    const persistence = new UsagePersistence(dir);
    await assert.doesNotReject(() => persistence.remove('nonexistent'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('UsagePersistence save replaces target atomically without leaving temp files behind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
  try {
    const persistence = new UsagePersistence(dir);
    await persistence.save(makeUsage('conv-1'));

    const usageDir = path.join(dir, 'usage');
    const files = await fs.readdir(usageDir);

    assert.deepEqual(files, ['conv-1.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
