import assert from 'node:assert/strict';
import test from 'node:test';
import { TurnState } from './TurnState.js';

test('initial snapshot has zero counts', () => {
  const state = new TurnState();
  const snap = state.snapshot();
  assert.equal(snap.modelTurnCount, 0);
  assert.equal(snap.toolCallCount, 0);
  assert.equal(snap.pendingToolCalls, 0);
  assert.equal(snap.tokenUsage, undefined);
});

test('beginModelTurn increments model turn count', () => {
  const state = new TurnState();
  state.beginModelTurn();
  state.beginModelTurn();
  assert.equal(state.snapshot().modelTurnCount, 2);
});

test('registerToolCall increments tool call count and adds pending', () => {
  const state = new TurnState();
  state.registerToolCall('call-1');
  state.registerToolCall('call-2');
  const snap = state.snapshot();
  assert.equal(snap.toolCallCount, 2);
  assert.equal(snap.pendingToolCalls, 2);
});

test('resolveToolCall removes from pending', () => {
  const state = new TurnState();
  state.registerToolCall('call-1');
  state.registerToolCall('call-2');
  state.resolveToolCall('call-1');
  assert.equal(state.snapshot().pendingToolCalls, 1);
  assert.equal(state.snapshot().toolCallCount, 2);
});

test('resolveToolCall for unknown id is safe', () => {
  const state = new TurnState();
  state.resolveToolCall('nonexistent');
  assert.equal(state.snapshot().pendingToolCalls, 0);
});

test('setTokenUsage stores usage', () => {
  const state = new TurnState();
  state.setTokenUsage({ inputTokens: 5, outputTokens: 10, totalTokens: 15 });
  assert.deepEqual(state.snapshot().tokenUsage, { inputTokens: 5, outputTokens: 10, totalTokens: 15 });
});

test('setTokenUsage with undefined clears usage', () => {
  const state = new TurnState();
  state.setTokenUsage({ inputTokens: 5, outputTokens: 10, totalTokens: 15 });
  state.setTokenUsage(undefined);
  assert.equal(state.snapshot().tokenUsage, undefined);
});
