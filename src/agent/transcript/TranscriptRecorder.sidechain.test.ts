import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { TranscriptRecorder } from './TranscriptRecorder.js';
import { generateId } from '../../models/ModelClient.js';
import type { Message } from '../../models/ModelClient.js';
import type { AgentMetadata } from './types.js';

const TEST_DIR = path.join(process.cwd(), '.test-sidechains-' + Date.now());

function conversationHash(conversationId: string): string {
  return crypto.createHash('sha256').update(conversationId).digest('hex').slice(0, 16);
}

function makeMessage(role: Message['role'], content: string): Message {
  return { role, content, id: generateId(), timestamp: new Date().toISOString() };
}

test.afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

test('insertMessageChain with isSidechain writes to subagents directory', async () => {
  const recorder = new TranscriptRecorder(TEST_DIR);
  const convId = 'conv-sidechain-1';
  const agentId = 'subagent-general-purpose-abc123';

  const messages = [
    makeMessage('user', 'do something'),
    makeMessage('assistant', 'done'),
  ];

  await recorder.insertMessageChain(convId, messages, true, agentId);
  // Force flush
  await new Promise(r => setTimeout(r, 200));

  const hash = conversationHash(convId);
  const sidechainPath = path.join(TEST_DIR, hash, 'subagents', `agent-${agentId}.jsonl`);
  const content = await readFile(sidechainPath, 'utf8');
  const lines = content.trim().split('\n');

  assert.equal(lines.length, 2);
  const entry0 = JSON.parse(lines[0]);
  assert.equal(entry0.type, 'message');
  assert.equal(entry0.isSidechain, true);
  assert.equal(entry0.agentId, agentId);
  assert.equal(entry0.message.content, 'do something');

  const entry1 = JSON.parse(lines[1]);
  assert.equal(entry1.message.content, 'done');
  assert.equal(entry1.parentId, messages[0].id);
});

test('sidechain messages do not appear in main transcript', async () => {
  const recorder = new TranscriptRecorder(TEST_DIR);
  const convId = 'conv-sidechain-2';

  // Write to main transcript (user + assistant to avoid interrupted-turn detection)
  const userMsg = makeMessage('user', 'main message');
  const assistantMsg = makeMessage('assistant', 'main reply');
  await recorder.recordMessage(convId, userMsg);
  await recorder.recordMessage(convId, assistantMsg);
  await new Promise(r => setTimeout(r, 200));

  // Write sidechain and wait for flush
  const sidechainMsgs = [makeMessage('user', 'sidechain msg')];
  await recorder.insertMessageChain(convId, sidechainMsgs, true, 'agent-x');
  await new Promise(r => setTimeout(r, 200));

  // Load main transcript — should not include sidechain messages
  const { messages } = await recorder.loadTranscript(convId);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'main message');
  assert.equal(messages[1].content, 'main reply');
  // Sidechain message should not be present
  assert.ok(!messages.some(m => m.content === 'sidechain msg'));
});

test('writeAgentMetadata writes .meta.json sidecar', async () => {
  const recorder = new TranscriptRecorder(TEST_DIR);
  const convId = 'conv-meta-1';
  const metadata: AgentMetadata = {
    agentId: 'subagent-general-purpose-xyz',
    agentType: 'general-purpose',
    description: 'A test subagent',
    createdAt: new Date().toISOString(),
    config: { maxTurns: 10 },
  };

  await recorder.writeAgentMetadata(convId, metadata);

  const hash = conversationHash(convId);
  const metaPath = path.join(TEST_DIR, hash, 'subagents', `agent-${metadata.agentId}.meta.json`);
  const content = await readFile(metaPath, 'utf8');
  const parsed = JSON.parse(content);

  assert.equal(parsed.agentId, metadata.agentId);
  assert.equal(parsed.agentType, 'general-purpose');
  assert.equal(parsed.description, 'A test subagent');
  assert.equal(parsed.config.maxTurns, 10);
});

test('recordMessage with isSidechain opts writes to subagent file', async () => {
  const recorder = new TranscriptRecorder(TEST_DIR);
  const convId = 'conv-sidechain-3';
  const agentId = 'fork-memory-abc';

  const msg = makeMessage('assistant', 'forked result');
  await recorder.recordMessage(convId, msg, {
    isSidechain: true,
    agentId,
  });

  await new Promise(r => setTimeout(r, 200));

  const hash = conversationHash(convId);
  const sidechainPath = path.join(TEST_DIR, hash, 'subagents', `agent-${agentId}.jsonl`);
  const content = await readFile(sidechainPath, 'utf8');
  const entry = JSON.parse(content.trim());

  assert.equal(entry.isSidechain, true);
  assert.equal(entry.agentId, agentId);
  assert.equal(entry.message.content, 'forked result');
});
