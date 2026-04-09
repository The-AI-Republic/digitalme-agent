import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutionState } from './TurnExecutionState.js';

describe('TurnExecutionState', () => {
  it('starts with zeroed counters', () => {
    const state = new TurnExecutionState();
    assert.strictEqual(state.iterationIndex, 0);
    assert.strictEqual(state.modelCallCount, 0);
    assert.strictEqual(state.toolCallCount, 0);
    assert.strictEqual(state.pendingToolCallIds.size, 0);
    assert.strictEqual(state.tokenUsage, undefined);
    assert.strictEqual(state.continuationReason, undefined);
    assert.strictEqual(state.terminalReason, undefined);
    assert.strictEqual(state.completedAt, undefined);
    assert.ok(state.startedAt > 0);
  });

  it('beginModelCall increments iteration and model count', () => {
    const state = new TurnExecutionState();
    state.beginModelCall();
    assert.strictEqual(state.iterationIndex, 1);
    assert.strictEqual(state.modelCallCount, 1);

    state.beginModelCall();
    assert.strictEqual(state.iterationIndex, 2);
    assert.strictEqual(state.modelCallCount, 2);
  });

  it('tracks tool call lifecycle', () => {
    const state = new TurnExecutionState();
    state.registerToolCall('call-1');
    state.registerToolCall('call-2');

    assert.strictEqual(state.toolCallCount, 2);
    assert.strictEqual(state.pendingToolCallIds.size, 2);
    assert.ok(state.pendingToolCallIds.has('call-1'));
    assert.ok(state.pendingToolCallIds.has('call-2'));

    state.resolveToolCall('call-1');
    assert.strictEqual(state.pendingToolCallIds.size, 1);
    assert.ok(!state.pendingToolCallIds.has('call-1'));
    assert.ok(state.pendingToolCallIds.has('call-2'));

    state.resolveToolCall('call-2');
    assert.strictEqual(state.pendingToolCallIds.size, 0);
    // toolCallCount stays at 2 — it's cumulative
    assert.strictEqual(state.toolCallCount, 2);
  });

  it('sets token usage', () => {
    const state = new TurnExecutionState();
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
    state.setTokenUsage(usage);
    assert.deepStrictEqual(state.tokenUsage, usage);
  });

  it('dispose sets terminal reason and completedAt', () => {
    const state = new TurnExecutionState();
    assert.strictEqual(state.terminalReason, undefined);
    assert.strictEqual(state.completedAt, undefined);

    state.dispose('final_text');
    assert.strictEqual(state.terminalReason, 'final_text');
    assert.ok(state.completedAt! >= state.startedAt);
  });

  it('dispose with max_turns reason', () => {
    const state = new TurnExecutionState();
    state.dispose('max_turns');
    assert.strictEqual(state.terminalReason, 'max_turns');
  });

  it('snapshot returns all fields', () => {
    const state = new TurnExecutionState();
    state.beginModelCall();
    state.registerToolCall('c1');
    state.setTokenUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    state.continuationReason = 'tool_calls';

    const snap = state.snapshot();
    assert.strictEqual(snap.iterationIndex, 1);
    assert.strictEqual(snap.modelCallCount, 1);
    assert.strictEqual(snap.toolCallCount, 1);
    assert.strictEqual(snap.pendingToolCalls, 1);
    assert.deepStrictEqual(snap.tokenUsage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    assert.strictEqual(snap.continuationReason, 'tool_calls');
    assert.strictEqual(snap.terminalReason, undefined);
    assert.ok(snap.durationMs >= 0);
  });

  it('snapshot durationMs uses completedAt when disposed', () => {
    const state = new TurnExecutionState();
    state.dispose('final_text');

    const snap = state.snapshot();
    assert.strictEqual(snap.durationMs, state.completedAt! - state.startedAt);
  });

  it('is not leaked — each instance is independent', () => {
    const state1 = new TurnExecutionState();
    const state2 = new TurnExecutionState();

    state1.beginModelCall();
    state1.registerToolCall('a');

    assert.strictEqual(state2.iterationIndex, 0);
    assert.strictEqual(state2.toolCallCount, 0);
    assert.strictEqual(state2.pendingToolCallIds.size, 0);
  });
});
