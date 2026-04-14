/**
 * Tests for SkillTracker execution tracking.
 * Covers Track 14: skill execution recording and stats.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillTracker } from './SkillTracker.js';
import type { SkillExecutionRecord } from './types.js';

function makeRecord(overrides: Partial<SkillExecutionRecord> = {}): SkillExecutionRecord {
  return {
    skillName: 'test-skill',
    conversationId: 'conv-1',
    timestamp: Date.now(),
    context: 'inline',
    success: true,
    latencyMs: 100,
    turnsUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolsUsed: [],
    ...overrides,
  };
}

test('SkillTracker records execution and notifies listeners', () => {
  const tracker = new SkillTracker();
  const received: SkillExecutionRecord[] = [];
  tracker.onExecution((record) => received.push(record));

  const record = makeRecord();
  tracker.record(record);

  assert.equal(tracker.getRecords().length, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].skillName, 'test-skill');
});

test('SkillTracker getRecordsForSkill filters by name', () => {
  const tracker = new SkillTracker();
  tracker.record(makeRecord({ skillName: 'skill-a' }));
  tracker.record(makeRecord({ skillName: 'skill-b' }));
  tracker.record(makeRecord({ skillName: 'skill-a' }));

  const results = tracker.getRecordsForSkill('skill-a');
  assert.equal(results.length, 2);
});

test('SkillTracker getStats aggregates correctly', () => {
  const tracker = new SkillTracker();
  tracker.record(makeRecord({ skillName: 'skill-a', success: true, latencyMs: 100 }));
  tracker.record(makeRecord({ skillName: 'skill-a', success: false, latencyMs: 200 }));
  tracker.record(makeRecord({ skillName: 'skill-b', success: true, latencyMs: 300 }));

  const stats = tracker.getStats();
  assert.equal(stats.totalExecutions, 3);
  assert.equal(stats.successCount, 2);
  assert.equal(stats.failureCount, 1);
  assert.equal(stats.totalLatencyMs, 600);
  assert.equal(stats.avgLatencyMs, 200);
  assert.equal(stats.bySkill['skill-a'].count, 2);
  assert.equal(stats.bySkill['skill-a'].successCount, 1);
  assert.equal(stats.bySkill['skill-b'].count, 1);
});

test('SkillTracker handles listener errors gracefully', () => {
  const tracker = new SkillTracker();
  tracker.onExecution(() => { throw new Error('listener failure'); });

  // Should not throw
  assert.doesNotThrow(() => tracker.record(makeRecord()));
  assert.equal(tracker.getRecords().length, 1);
});

test('SkillTracker empty stats are correct', () => {
  const tracker = new SkillTracker();
  const stats = tracker.getStats();
  assert.equal(stats.totalExecutions, 0);
  assert.equal(stats.avgLatencyMs, 0);
});
