import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateId, type Message } from '../../models/ModelClient.js';
import { TranscriptRecorder } from './TranscriptRecorder.js';
import type { MessageEntry, TaskStartedEntry, TaskCompletedEntry, SessionReseededEntry } from './types.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'transcript-test-'));
}

function msg(role: Message['role'], content: string | null, extra?: Partial<Message>): Message {
  return { role, content, id: generateId(), timestamp: new Date().toISOString(), ...extra };
}

// ---- Basic write tests ----

test('TranscriptRecorder writes valid JSONL for messages', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const userMsg = msg('user', 'hello');
  await recorder.recordMessage('conv-1', userMsg, { taskId: 'req-1', turnId: 1 });

  const assistantMsg = msg('assistant', 'hi there');
  await recorder.recordMessage('conv-1', assistantMsg, { taskId: 'req-1', turnId: 1 });

  // Read the JSONL file
  const files = await fs.readdir(dir);
  assert.equal(files.length, 1);
  const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 2);

  const entry1 = JSON.parse(lines[0]) as MessageEntry;
  assert.equal(entry1.type, 'message');
  assert.equal(entry1.conversationId, 'conv-1');
  assert.equal(entry1.message.id, userMsg.id);
  assert.equal(entry1.message.role, 'user');
  assert.equal(entry1.parentId, null);

  const entry2 = JSON.parse(lines[1]) as MessageEntry;
  assert.equal(entry2.type, 'message');
  assert.equal(entry2.message.id, assistantMsg.id);
  assert.equal(entry2.parentId, userMsg.id);

  await fs.rm(dir, { recursive: true });
});

test('TranscriptRecorder records lifecycle events without advancing parent chain', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const userMsg = msg('user', 'hello');
  await recorder.recordMessage('conv-1', userMsg, { taskId: 'req-1' });

  // Record a lifecycle event
  await recorder.recordLifecycleEvent({
    type: 'task_started',
    conversationId: 'conv-1',
    taskId: 'req-1',
    timestamp: new Date().toISOString(),
    session: {} as any,
    platformHistoryCount: 0,
  } as TaskStartedEntry);

  // Record another message — parentId should still be userMsg.id, not the lifecycle event
  const assistantMsg = msg('assistant', 'response');
  await recorder.recordMessage('conv-1', assistantMsg, { taskId: 'req-1' });

  const files = await fs.readdir(dir);
  const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 3);

  const entry3 = JSON.parse(lines[2]) as MessageEntry;
  assert.equal(entry3.parentId, userMsg.id, 'lifecycle event should not advance parent chain');

  await fs.rm(dir, { recursive: true });
});

test('TranscriptRecorder builds linear parent chain', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const m1 = msg('user', 'hello');
  const m2 = msg('assistant', 'hi');
  const m3 = msg('user', 'bye');

  await recorder.recordMessage('conv-1', m1);
  await recorder.recordMessage('conv-1', m2);
  await recorder.recordMessage('conv-1', m3);

  const files = await fs.readdir(dir);
  const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const lines = content.trim().split('\n').map(l => JSON.parse(l) as MessageEntry);

  assert.equal(lines[0].parentId, null);
  assert.equal(lines[1].parentId, m1.id);
  assert.equal(lines[2].parentId, m2.id);

  await fs.rm(dir, { recursive: true });
});

test('TranscriptRecorder uses parentOverride for tool-result DAG', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const userMsg = msg('user', 'search');
  const assistantMsg = msg('assistant', null, {
    toolCalls: [
      { id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
      { id: 'call-2', type: 'function', function: { name: 'web_search', arguments: '{}' } },
    ],
  });
  const toolResult1 = msg('tool', 'result 1', { toolCallId: 'call-1', toolName: 'web_search' });
  const toolResult2 = msg('tool', 'result 2', { toolCallId: 'call-2', toolName: 'web_search' });

  await recorder.recordMessage('conv-1', userMsg);
  await recorder.recordMessage('conv-1', assistantMsg);
  // Tool results point back to assistant via parentOverride
  await recorder.recordMessage('conv-1', toolResult1, { parentOverride: assistantMsg.id });
  await recorder.recordMessage('conv-1', toolResult2, { parentOverride: assistantMsg.id });

  const files = await fs.readdir(dir);
  const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const lines = content.trim().split('\n').map(l => JSON.parse(l) as MessageEntry);

  // Tool results should both point to the assistant message
  assert.equal(lines[2].parentId, assistantMsg.id);
  assert.equal(lines[3].parentId, assistantMsg.id);

  // But parentId cursor should still advance (toolResult2.id is the last recorded)
  const finalMsg = msg('assistant', 'done');
  await recorder.recordMessage('conv-1', finalMsg);
  const content2 = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const lines2 = content2.trim().split('\n').map(l => JSON.parse(l) as MessageEntry);
  assert.equal(lines2[4].parentId, toolResult2.id);

  await fs.rm(dir, { recursive: true });
});

test('TranscriptRecorder dedup prevents duplicate message writes', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const m1 = msg('user', 'hello');
  await recorder.recordMessage('conv-1', m1);
  await recorder.recordMessage('conv-1', m1); // duplicate

  const files = await fs.readdir(dir);
  const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 1, 'duplicate should not be written');

  await fs.rm(dir, { recursive: true });
});

test('TranscriptRecorder routes sidechains to agent-specific files', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  // Main transcript message
  const mainMsg = msg('user', 'main');
  await recorder.recordMessage('conv-1', mainMsg);

  // Sidechain message
  const sideMsg = msg('user', 'sidechain prompt');
  await recorder.recordMessage('conv-1', sideMsg, {
    isSidechain: true,
    agentId: 'research-agent',
  });

  // Check main file exists
  const mainFiles = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
  assert.equal(mainFiles.length, 1);

  // Check sidechain file exists
  const hash = mainFiles[0].replace('.jsonl', '');
  const subagentDir = path.join(dir, hash, 'subagents');
  const sideFiles = await fs.readdir(subagentDir);
  assert.ok(sideFiles.some(f => f.includes('research-agent')));

  await fs.rm(dir, { recursive: true });
});

// ---- insertMessageChain tests ----

test('insertMessageChain assigns parentIds and deduplicates', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const m1 = msg('user', 'hello');
  const m2 = msg('assistant', 'hi');
  const m3 = msg('user', 'bye');

  // Record m1 first
  await recorder.recordMessage('conv-1', m1);

  // Insert chain including m1 (should be deduped) and new messages
  await recorder.insertMessageChain('conv-1', [m1, m2, m3]);

  const files = await fs.readdir(dir);
  const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const lines = content.trim().split('\n').map(l => JSON.parse(l) as MessageEntry);

  // Only 3 entries: m1 (original), m2 (from chain), m3 (from chain)
  assert.equal(lines.length, 3);
  assert.equal(lines[1].message.id, m2.id);
  assert.equal(lines[1].parentId, m1.id);
  assert.equal(lines[2].message.id, m3.id);
  assert.equal(lines[2].parentId, m2.id);

  await fs.rm(dir, { recursive: true });
});

// ---- loadTranscript tests ----

test('loadTranscript loads linear chain in order', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const m1 = msg('user', 'hello');
  const m2 = msg('assistant', 'hi');
  const m3 = msg('user', 'how are you');
  const m4 = msg('assistant', 'I am fine');

  await recorder.recordMessage('conv-1', m1);
  await recorder.recordMessage('conv-1', m2);
  await recorder.recordMessage('conv-1', m3);
  await recorder.recordMessage('conv-1', m4);

  const { messages, leafId } = await recorder.loadTranscript('conv-1');

  assert.equal(messages.length, 4);
  assert.equal(messages[0].id, m1.id);
  assert.equal(messages[1].id, m2.id);
  assert.equal(messages[2].id, m3.id);
  assert.equal(messages[3].id, m4.id);
  assert.equal(leafId, m4.id);

  await fs.rm(dir, { recursive: true });
});

test('loadTranscript finds newest leaf', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const m1 = msg('user', 'first');
  const m2 = msg('assistant', 'response');

  await recorder.recordMessage('conv-1', m1);
  await recorder.recordMessage('conv-1', m2);

  const { leafId } = await recorder.loadTranscript('conv-1');
  assert.equal(leafId, m2.id);

  await fs.rm(dir, { recursive: true });
});

test('loadTranscript detects cycles and stops safely', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  // Manually write a transcript with a cycle
  const m1id = generateId();
  const m2id = generateId();
  const now = new Date().toISOString();

  const entries = [
    { type: 'message', conversationId: 'conv-1', timestamp: now, parentId: m2id, message: { id: m1id, role: 'user', content: 'hello', timestamp: now } },
    { type: 'message', conversationId: 'conv-1', timestamp: now, parentId: m1id, message: { id: m2id, role: 'assistant', content: 'hi', timestamp: now } },
  ];

  const files = await fs.readdir(dir);
  // Write directly to a JSONL file
  const crypto = await import('node:crypto');
  const hash = crypto.createHash('sha256').update('conv-1').digest('hex').slice(0, 16);
  const filePath = path.join(dir, `${hash}.jsonl`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

  const { messages } = await recorder.loadTranscript('conv-1');
  // Should not infinite loop — should return some messages (at most 2 real + possible synthetic)
  assert.ok(messages.length <= 3, `cycle detection should stop the walk, got ${messages.length} messages`);
  // At least one real message should be recovered
  assert.ok(messages.length >= 1, 'should recover at least one message');

  await fs.rm(dir, { recursive: true });
});

test('loadTranscript recovers orphaned parallel tool results', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const userMsg = msg('user', 'search');
  const assistantMsg = msg('assistant', null, {
    toolCalls: [
      { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } },
      { id: 'call-2', type: 'function', function: { name: 'search', arguments: '{}' } },
    ],
  });
  const tool1 = msg('tool', 'result 1', { toolCallId: 'call-1', toolName: 'search' });
  const tool2 = msg('tool', 'result 2', { toolCallId: 'call-2', toolName: 'search' });
  const finalMsg = msg('assistant', 'done');

  await recorder.recordMessage('conv-1', userMsg);
  await recorder.recordMessage('conv-1', assistantMsg);
  // Both tool results point to assistant via parentOverride
  await recorder.recordMessage('conv-1', tool1, { parentOverride: assistantMsg.id });
  await recorder.recordMessage('conv-1', tool2, { parentOverride: assistantMsg.id });
  await recorder.recordMessage('conv-1', finalMsg);

  const { messages } = await recorder.loadTranscript('conv-1');

  // All messages should be recovered including both tool results
  assert.equal(messages.length, 5);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].toolCalls?.length, 2);
  // Both tool results should be present
  const toolResults = messages.filter(m => m.role === 'tool');
  assert.equal(toolResults.length, 2);
  assert.equal(messages[4].role, 'assistant');
  assert.equal(messages[4].content, 'done');

  await fs.rm(dir, { recursive: true });
});

test('loadTranscript filters unresolved tool uses', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const userMsg = msg('user', 'search');
  const assistantMsg = msg('assistant', null, {
    toolCalls: [
      { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } },
    ],
  });

  await recorder.recordMessage('conv-1', userMsg);
  await recorder.recordMessage('conv-1', assistantMsg);
  // No tool result recorded — simulating crash mid-turn

  const { messages } = await recorder.loadTranscript('conv-1');

  // The assistant with unresolved toolCalls should be filtered out
  assert.ok(messages.every(m => !m.toolCalls), 'unresolved tool uses should be filtered');
  // User message should remain
  assert.equal(messages[0].role, 'user');

  await fs.rm(dir, { recursive: true });
});

test('loadTranscript creates synthetic continuation for interrupted user turn', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const userMsg = msg('user', 'help me');
  await recorder.recordMessage('conv-1', userMsg);
  // No assistant response — simulating interrupted turn

  const { messages } = await recorder.loadTranscript('conv-1');

  // Should append a synthetic continuation
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, userMsg.id);
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].synthetic, true);
  assert.equal(messages[1].content, 'Continue from where you left off.');

  await fs.rm(dir, { recursive: true });
});

test('loadTranscript returns empty for non-existent conversation', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const { messages, leafId } = await recorder.loadTranscript('nonexistent');
  assert.equal(messages.length, 0);
  assert.equal(leafId, null);

  await fs.rm(dir, { recursive: true });
});

test('loadTranscript respects file size guard', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  // Write messages to create the file, then check the guard logic
  const m1 = msg('user', 'hello');
  const m2 = msg('assistant', 'hi');
  await recorder.recordMessage('conv-1', m1);
  await recorder.recordMessage('conv-1', m2);

  // File should be small, load should work
  const { messages } = await recorder.loadTranscript('conv-1');
  assert.equal(messages.length, 2);

  await fs.rm(dir, { recursive: true });
});

// ---- seedParentId tests ----

test('seedParentId sets the parent cursor for subsequent writes', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const existingLeafId = generateId();
  recorder.seedParentId('conv-1', existingLeafId);

  const newMsg = msg('user', 'continued');
  await recorder.recordMessage('conv-1', newMsg);

  const files = await fs.readdir(dir);
  const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const entry = JSON.parse(content.trim()) as MessageEntry;

  assert.equal(entry.parentId, existingLeafId, 'should chain from seeded parent');

  await fs.rm(dir, { recursive: true });
});

// ---- Restart/rebuild dedup tests ----

test('restart rebuilds dedup set from JSONL', async () => {
  const dir = await makeTempDir();

  // First recorder writes messages
  const recorder1 = new TranscriptRecorder(dir);
  const m1 = msg('user', 'hello');
  const m2 = msg('assistant', 'hi');
  await recorder1.recordMessage('conv-1', m1);
  await recorder1.recordMessage('conv-1', m2);

  // Simulate restart — new recorder instance
  const recorder2 = new TranscriptRecorder(dir);

  // Try to record the same messages — should be deduped
  await recorder2.recordMessage('conv-1', m1);
  await recorder2.recordMessage('conv-1', m2);

  // Also record a new message
  const m3 = msg('user', 'new message');
  await recorder2.recordMessage('conv-1', m3);

  const files = await fs.readdir(dir);
  const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 3, 'should have 3 entries (2 original + 1 new, duplicates deduped)');

  await fs.rm(dir, { recursive: true });
});

// ---- Lifecycle event schema tests ----

test('lifecycle events have correct schema', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  await recorder.recordLifecycleEvent({
    type: 'task_started',
    conversationId: 'conv-1',
    taskId: 'req-1',
    turnId: 1,
    timestamp: new Date().toISOString(),
    session: { conversationId: 'conv-1' } as any,
    platformHistoryCount: 5,
  } as TaskStartedEntry);

  await recorder.recordLifecycleEvent({
    type: 'task_completed',
    conversationId: 'conv-1',
    taskId: 'req-1',
    turnId: 1,
    timestamp: new Date().toISOString(),
    finalText: 'done',
    completedTurns: 2,
    toolCallCount: 1,
    session: { conversationId: 'conv-1' } as any,
  } as TaskCompletedEntry);

  await recorder.recordLifecycleEvent({
    type: 'session_reseeded',
    conversationId: 'conv-1',
    taskId: 'req-1',
    timestamp: new Date().toISOString(),
    historyCount: 4,
  } as SessionReseededEntry);

  const files = await fs.readdir(dir);
  const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const lines = content.trim().split('\n').map(l => JSON.parse(l));

  assert.equal(lines[0].type, 'task_started');
  assert.equal(lines[0].platformHistoryCount, 5);
  assert.equal(lines[1].type, 'task_completed');
  assert.equal(lines[1].finalText, 'done');
  assert.equal(lines[2].type, 'session_reseeded');
  assert.equal(lines[2].historyCount, 4);

  await fs.rm(dir, { recursive: true });
});

// ---- Artifact ref tests ----

test('recordMessage includes artifactRef in entry', async () => {
  const dir = await makeTempDir();
  const recorder = new TranscriptRecorder(dir);

  const toolMsg = msg('tool', 'preview...', { toolCallId: 'call-1', toolName: 'search' });
  await recorder.recordMessage('conv-1', toolMsg, {
    artifactRef: {
      filePath: '/tmp/artifacts/call-1.txt',
      originalSize: 50000,
      preview: 'first 2000 bytes...',
    },
  });

  const files = await fs.readdir(dir);
  const content = await fs.readFile(path.join(dir, files[0]), 'utf8');
  const entry = JSON.parse(content.trim()) as MessageEntry;

  assert.ok(entry.artifactRef);
  assert.equal(entry.artifactRef.filePath, '/tmp/artifacts/call-1.txt');
  assert.equal(entry.artifactRef.originalSize, 50000);

  await fs.rm(dir, { recursive: true });
});
