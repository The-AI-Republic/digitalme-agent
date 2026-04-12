import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  TranscriptEntry,
  ForkStartedEntry,
  ForkCompletedEntry,
  ForkFailedEntry,
  ForkRejectedEntry,
  SubagentStartedEntry,
  SubagentCompletedEntry,
  SubagentFailedEntry,
  HookExecutedEntry,
  CompactStartedEntry,
  CompactCompletedEntry,
  HookOutcome,
} from './types.js';

// These tests verify that the TypeScript types compile correctly.
// Runtime assertions confirm the type union includes all expected values.

test('TranscriptEntry.type union includes fork lifecycle types', () => {
  const types: TranscriptEntry['type'][] = [
    'fork_started',
    'fork_completed',
    'fork_failed',
    'fork_rejected',
  ];
  for (const t of types) {
    assert.ok(typeof t === 'string', `type ${t} should be a string`);
  }
});

test('TranscriptEntry.type union includes subagent lifecycle types', () => {
  const types: TranscriptEntry['type'][] = [
    'subagent_started',
    'subagent_completed',
    'subagent_failed',
  ];
  for (const t of types) {
    assert.ok(typeof t === 'string', `type ${t} should be a string`);
  }
});

test('TranscriptEntry.type union includes hook_executed', () => {
  const t: TranscriptEntry['type'] = 'hook_executed';
  assert.equal(t, 'hook_executed');
});

test('TranscriptEntry.type union includes compact types', () => {
  const types: TranscriptEntry['type'][] = [
    'compact_started',
    'compact_completed',
  ];
  for (const t of types) {
    assert.ok(typeof t === 'string', `type ${t} should be a string`);
  }
});

test('TranscriptEntry.type union includes original types', () => {
  const types: TranscriptEntry['type'][] = [
    'message',
    'task_started',
    'task_completed',
    'task_failed',
    'session_reseeded',
  ];
  for (const t of types) {
    assert.ok(typeof t === 'string', `type ${t} should be a string`);
  }
});

test('HookOutcome type includes all expected values', () => {
  const outcomes: HookOutcome[] = ['success', 'error', 'timeout'];
  assert.equal(outcomes.length, 3);
});

test('ForkRejectedEntry reason is constrained', () => {
  // Type-level check: only these two values are valid
  const reasons: ForkRejectedEntry['reason'][] = ['semaphore_full', 'forks_disabled'];
  assert.equal(reasons.length, 2);
});

test('ForkCompletedEntry includes tokenUsage and toolCallCount', () => {
  const entry: ForkCompletedEntry = {
    type: 'fork_completed',
    conversationId: 'conv-1',
    timestamp: new Date().toISOString(),
    forkId: 'fork-1',
    forkLabel: 'test',
    tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    durationMs: 500,
    toolCallCount: 3,
  };
  assert.equal(entry.type, 'fork_completed');
  assert.equal(entry.toolCallCount, 3);
  assert.ok(entry.tokenUsage);
});

test('SubagentCompletedEntry includes all required fields', () => {
  const entry: SubagentCompletedEntry = {
    type: 'subagent_completed',
    conversationId: 'conv-1',
    timestamp: new Date().toISOString(),
    subagentType: 'general-purpose',
    toolCallCount: 5,
    completedTurns: 3,
    durationMs: 1200,
    model: 'gpt-4',
  };
  assert.equal(entry.type, 'subagent_completed');
  assert.equal(entry.subagentType, 'general-purpose');
  assert.equal(entry.toolCallCount, 5);
  assert.equal(entry.completedTurns, 3);
});

test('CompactStartedEntry has pressureBand field', () => {
  const entry: CompactStartedEntry = {
    type: 'compact_started',
    conversationId: 'conv-1',
    timestamp: new Date().toISOString(),
    trigger: 'proactive',
    pressureBand: 'microcompact',
  };
  assert.equal(entry.trigger, 'proactive');
  assert.equal(entry.pressureBand, 'microcompact');
});
