import test from 'node:test';
import assert from 'node:assert/strict';

import { truncateResult, ResultBudget } from './ResultBudget.js';

// --- truncateResult ---

test('truncateResult leaves short strings unchanged', () => {
  const result = truncateResult('hello', 100);
  assert.equal(result.content, 'hello');
  assert.equal(result.truncated, false);
  assert.equal(result.originalChars, 5);
});

test('truncateResult leaves string exactly at limit unchanged', () => {
  const content = 'x'.repeat(100);
  const result = truncateResult(content, 100);
  assert.equal(result.content, content);
  assert.equal(result.truncated, false);
});

test('truncateResult truncates long strings with suffix', () => {
  const content = 'a'.repeat(200);
  const result = truncateResult(content, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.originalChars, 200);
  assert.ok(result.content.includes('[truncated'));
});

test('truncateResult never returns content longer than maxChars', () => {
  const content = 'a'.repeat(10000);
  for (const max of [50, 100, 500, 1000, 5000]) {
    const result = truncateResult(content, max);
    assert.ok(result.content.length <= max, `Expected <= ${max}, got ${result.content.length}`);
  }
});

test('truncateResult returns minimal placeholder for very small budgets', () => {
  const content = 'a'.repeat(200);
  const result = truncateResult(content, 10);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 10);
});

test('truncateResult returns empty for zero budget', () => {
  const result = truncateResult('hello', 0);
  assert.equal(result.truncated, true);
  assert.equal(result.content, '');
});

test('truncateResult prefers newline boundaries', () => {
  const content = 'line1\nline2\nline3\nline4\nline5\n' + 'x'.repeat(200);
  const result = truncateResult(content, 80);
  assert.equal(result.truncated, true);
  // The content before the truncation marker should end at a newline
  const parts = result.content.split('\n[truncated');
  assert.ok(parts.length >= 2, 'Expected truncation marker');
  // The body before the marker should contain complete lines
  const body = parts[0]!;
  const lastNewline = body.lastIndexOf('\n');
  // Should not have partial 'x' content — cut should be at a line boundary
  assert.ok(lastNewline > 0, `Expected newline in body, got: "${body.slice(-20)}"`);
});

// --- ResultBudget ---

test('ResultBudget.truncateAndConsume reduces remaining', () => {
  const budget = new ResultBudget(1000);
  const result = budget.truncateAndConsume('hello world', 500);
  assert.equal(result.truncated, false);
  assert.equal(budget.remaining, 1000 - 11);
});

test('ResultBudget.truncateAndConsume truncates when over per-tool limit', () => {
  const budget = new ResultBudget(10_000);
  const content = 'x'.repeat(500);
  const result = budget.truncateAndConsume(content, 100);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 100);
});

test('ResultBudget.truncateAndConsume truncates when aggregate exhausted', () => {
  const budget = new ResultBudget(100);
  budget.truncateAndConsume('a'.repeat(80), 200); // consume 80
  const result = budget.truncateAndConsume('b'.repeat(200), 200);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 20);
});

test('ResultBudget does not leak across separate instances', () => {
  const budget1 = new ResultBudget(100);
  budget1.truncateAndConsume('a'.repeat(90), 200);
  const budget2 = new ResultBudget(100);
  assert.equal(budget2.remaining, 100);
});

test('ResultBudget.normalizeBatch truncates largest results first', () => {
  const budget = new ResultBudget(100);
  const records = [
    makeRecord('call-1', 'small', 'x'.repeat(20)),
    makeRecord('call-2', 'large', 'y'.repeat(200)),
  ];

  budget.normalizeBatch(records);

  // The large one should be truncated, small one preserved
  assert.ok(records[0]!.modelContent.length <= 20);
  assert.ok(records[1]!.modelContent.length < 200);
  assert.equal(records[1]!.result.truncated, true);
});

test('ResultBudget.normalizeBatch updates consumed correctly', () => {
  const budget = new ResultBudget(200);
  const records = [
    makeRecord('call-1', 't1', 'x'.repeat(50)),
    makeRecord('call-2', 't2', 'y'.repeat(50)),
  ];
  budget.normalizeBatch(records);
  assert.equal(budget.remaining, 100);
});

test('ResultBudget.normalizeBatch is deterministic', () => {
  const run = () => {
    const budget = new ResultBudget(100);
    const records = [
      makeRecord('call-1', 't1', 'a'.repeat(60)),
      makeRecord('call-2', 't2', 'b'.repeat(60)),
    ];
    budget.normalizeBatch(records);
    return records.map(r => r.modelContent.length);
  };
  assert.deepEqual(run(), run());
});

test('ResultBudget later batches see reduced remaining', () => {
  const budget = new ResultBudget(200);
  const batch1 = [makeRecord('call-1', 't1', 'x'.repeat(100))];
  budget.normalizeBatch(batch1);
  assert.equal(budget.remaining, 100);

  const batch2 = [makeRecord('call-2', 't2', 'y'.repeat(200))];
  budget.normalizeBatch(batch2);
  assert.ok(batch2[0]!.modelContent.length <= 100);
});

test('ResultBudget.normalizeBatch stops when prior consumption already exceeds the cap', () => {
  const budget = new ResultBudget(10);
  (budget as unknown as { consumed: number }).consumed = 20;
  const records = [makeRecord('call-1', 't1', 'x')];

  budget.normalizeBatch(records);

  assert.equal(records[0]!.modelContent, '');
  assert.equal(records[0]!.result.truncated, true);
});

test('ResultBudget.normalizeBatch does not infinite loop when budget pre-exhausted', () => {
  const budget = new ResultBudget(50);
  // Consume the entire budget via serial path
  budget.truncateAndConsume('x'.repeat(50), 200);
  assert.equal(budget.remaining, 0);

  // normalizeBatch with content should terminate, not loop forever
  const records = [makeRecord('call-1', 't1', 'y'.repeat(100))];
  budget.normalizeBatch(records);
  // All content should be truncated to empty
  assert.equal(records[0]!.modelContent.length, 0);
  assert.equal(records[0]!.result.truncated, true);
});

function makeRecord(callId: string, toolName: string, modelContent: string) {
  return {
    callId,
    toolName,
    args: {},
    result: {
      success: true,
      truncated: false,
      originalChars: modelContent.length,
    },
    modelContent,
    durationMs: 0,
    summary: '',
  };
}
