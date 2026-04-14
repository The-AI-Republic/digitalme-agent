import test from 'node:test';
import assert from 'node:assert/strict';

import { UsageRecorder } from './UsageRecorder.js';
import type { ModelUsageRecord } from './types.js';

function makeRecorder(overrides?: Partial<ConstructorParameters<typeof UsageRecorder>[0]>) {
  return new UsageRecorder({
    provider: 'openai',
    model: 'gpt-4o',
    conversationId: 'conv-1',
    requestId: 'req-1',
    ...overrides,
  });
}

test('UsageRecorder.record creates a ModelUsageRecord from TokenUsage', () => {
  const recorder = makeRecorder();
  const record = recorder.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });

  assert.ok(record);
  assert.equal(record.requestId, 'req-1');
  assert.equal(record.conversationId, 'conv-1');
  assert.equal(record.provider, 'openai');
  assert.equal(record.model, 'gpt-4o');
  assert.equal(record.inputTokens, 100);
  assert.equal(record.outputTokens, 50);
  assert.equal(record.executionContext, 'main');
  assert.equal(record.isRetry, false);
  assert.equal(record.isFallback, false);
  assert.ok(record.estimatedCostUsd > 0);
  assert.ok(record.timestamp > 0);
});

test('UsageRecorder.record returns undefined for undefined token usage', () => {
  const recorder = makeRecorder();
  const record = recorder.record(undefined);
  assert.equal(record, undefined);
});

test('UsageRecorder.record uses model override from context', () => {
  const recorder = makeRecorder();
  const record = recorder.record(
    { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    { model: 'gpt-4o-mini' },
  );
  assert.ok(record);
  assert.equal(record.model, 'gpt-4o-mini');
});

test('UsageRecorder.record uses provider override from context', () => {
  const recorder = makeRecorder();
  const record = recorder.record(
    { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  );
  assert.ok(record);
  assert.equal(record.provider, 'anthropic');
  assert.equal(record.model, 'claude-sonnet-4-6');
  assert.equal(record.estimatedCostUsd, 3);
});

test('UsageRecorder.record sets retry and fallback flags', () => {
  const recorder = makeRecorder();
  const record = recorder.record(
    { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    { isRetry: true, isFallback: true },
  );
  assert.ok(record);
  assert.equal(record.isRetry, true);
  assert.equal(record.isFallback, true);
});

test('UsageRecorder tracks turn number and tool call count', () => {
  const recorder = makeRecorder();
  recorder.setTurnNumber(3);
  recorder.setToolCallCount(5);

  const record = recorder.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  assert.ok(record);
  assert.equal(record.turnNumber, 3);
  assert.equal(record.toolCallCount, 5);
});

test('UsageRecorder.onRecord listener receives each record', () => {
  const recorder = makeRecorder();
  const received: ModelUsageRecord[] = [];
  recorder.onRecord((record) => received.push(record));

  recorder.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  recorder.record({ inputTokens: 200, outputTokens: 100, totalTokens: 300 });

  assert.equal(received.length, 2);
  assert.equal(received[0]!.inputTokens, 100);
  assert.equal(received[1]!.inputTokens, 200);
});

test('UsageRecorder.onRecord does not fire for undefined token usage', () => {
  const recorder = makeRecorder();
  const received: ModelUsageRecord[] = [];
  recorder.onRecord((record) => received.push(record));

  recorder.record(undefined);
  assert.equal(received.length, 0);
});

test('UsageRecorder.getRecords returns all recorded records', () => {
  const recorder = makeRecorder();
  recorder.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  recorder.record({ inputTokens: 200, outputTokens: 100, totalTokens: 300 });

  const records = recorder.getRecords();
  assert.equal(records.length, 2);
});

test('UsageRecorder.getTotalCost sums estimated costs', () => {
  const recorder = makeRecorder();
  recorder.record({ inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
  recorder.record({ inputTokens: 0, outputTokens: 1_000_000, totalTokens: 1_000_000 });

  // gpt-4o: $2.5/1M input + $10/1M output
  const totalCost = recorder.getTotalCost();
  assert.equal(totalCost, 2.5 + 10.0);
});

test('UsageRecorder.getTotalTokens aggregates input and output', () => {
  const recorder = makeRecorder();
  recorder.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  recorder.record({ inputTokens: 200, outputTokens: 100, totalTokens: 300 });

  const tokens = recorder.getTotalTokens();
  assert.equal(tokens.input, 300);
  assert.equal(tokens.output, 150);
  assert.equal(tokens.total, 450);
});

test('UsageRecorder uses executionContext from options', () => {
  const recorder = makeRecorder({ executionContext: 'background' });
  const record = recorder.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  assert.ok(record);
  assert.equal(record.executionContext, 'background');
});

test('UsageRecorder uses creatorId from options', () => {
  const recorder = makeRecorder({ creatorId: 'creator-42' });
  const record = recorder.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  assert.ok(record);
  assert.equal(record.creatorId, 'creator-42');
});

test('UsageRecorder supports multiple listeners', () => {
  const recorder = makeRecorder();
  const a: ModelUsageRecord[] = [];
  const b: ModelUsageRecord[] = [];
  recorder.onRecord((r) => a.push(r));
  recorder.onRecord((r) => b.push(r));

  recorder.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});
