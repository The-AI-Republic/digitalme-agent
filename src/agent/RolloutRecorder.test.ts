import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RolloutRecorder } from './RolloutRecorder.js';

async function withTmpDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rollout-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('record creates a JSONL file named by conversation hash', async () => {
  await withTmpDir(async (dir) => {
    const recorder = new RolloutRecorder(dir);
    await recorder.record({
      type: 'test_event',
      conversationId: 'conv-123',
      taskId: 'task-1',
    });

    const files = await import('node:fs/promises').then((m) => m.readdir(dir));
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.jsonl'));

    const content = await readFile(path.join(dir, files[0]), 'utf8');
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.type, 'test_event');
    assert.equal(parsed.conversationId, 'conv-123');
    assert.equal(parsed.taskId, 'task-1');
    assert.ok(parsed.timestamp);
  });
});

test('record appends multiple entries to the same file for one conversation', async () => {
  await withTmpDir(async (dir) => {
    const recorder = new RolloutRecorder(dir);
    await recorder.record({ type: 'first', conversationId: 'conv-1', taskId: 't1' });
    await recorder.record({ type: 'second', conversationId: 'conv-1', taskId: 't1' });

    const files = await import('node:fs/promises').then((m) => m.readdir(dir));
    assert.equal(files.length, 1);

    const lines = (await readFile(path.join(dir, files[0]), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, 'first');
    assert.equal(JSON.parse(lines[1]).type, 'second');
  });
});

test('record uses different files for different conversations', async () => {
  await withTmpDir(async (dir) => {
    const recorder = new RolloutRecorder(dir);
    await recorder.record({ type: 'a', conversationId: 'conv-a', taskId: 't1' });
    await recorder.record({ type: 'b', conversationId: 'conv-b', taskId: 't1' });

    const files = await import('node:fs/promises').then((m) => m.readdir(dir));
    assert.equal(files.length, 2);
  });
});

test('record produces deterministic file names for same conversation', async () => {
  await withTmpDir(async (dir) => {
    const recorder = new RolloutRecorder(dir);
    await recorder.record({ type: 'e1', conversationId: 'same-id', taskId: 't1' });
    await recorder.record({ type: 'e2', conversationId: 'same-id', taskId: 't2' });

    const files = await import('node:fs/promises').then((m) => m.readdir(dir));
    assert.equal(files.length, 1, 'same conversation should write to same file');
  });
});

test('record truncates long strings in data via sanitizeData', async () => {
  await withTmpDir(async (dir) => {
    const recorder = new RolloutRecorder(dir);
    const longString = 'x'.repeat(3000);
    await recorder.record({
      type: 'test',
      conversationId: 'conv-1',
      taskId: 't1',
      data: { content: longString },
    });

    const files = await import('node:fs/promises').then((m) => m.readdir(dir));
    const content = await readFile(path.join(dir, files[0]), 'utf8');
    const parsed = JSON.parse(content.trim());
    assert.ok((parsed.data.content as string).length < 3000);
    assert.ok((parsed.data.content as string).includes('<truncated>'));
  });
});

test('record handles nested objects and arrays in data', async () => {
  await withTmpDir(async (dir) => {
    const recorder = new RolloutRecorder(dir);
    await recorder.record({
      type: 'test',
      conversationId: 'conv-1',
      taskId: 't1',
      data: {
        nested: { value: 'hello' },
        list: ['a', 'b'],
      },
    });

    const files = await import('node:fs/promises').then((m) => m.readdir(dir));
    const content = await readFile(path.join(dir, files[0]), 'utf8');
    const parsed = JSON.parse(content.trim());
    assert.deepEqual(parsed.data.nested, { value: 'hello' });
    assert.deepEqual(parsed.data.list, ['a', 'b']);
  });
});

test('record preserves explicit timestamp if provided', async () => {
  await withTmpDir(async (dir) => {
    const recorder = new RolloutRecorder(dir);
    await recorder.record({
      type: 'test',
      conversationId: 'conv-1',
      taskId: 't1',
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    const files = await import('node:fs/promises').then((m) => m.readdir(dir));
    const content = await readFile(path.join(dir, files[0]), 'utf8');
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.timestamp, '2025-01-01T00:00:00.000Z');
  });
});
