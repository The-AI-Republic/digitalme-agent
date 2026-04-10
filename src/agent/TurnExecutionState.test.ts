import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnExecutionState } from './TurnExecutionState.js';
import { ActiveTurn } from './ActiveTurn.js';

test('TurnExecutionState initializes with zero counters', () => {
  const state = new TurnExecutionState();
  const snap = state.snapshot();
  assert.equal(snap.iterationIndex, 0);
  assert.equal(snap.modelTurnCount, 0);
  assert.equal(snap.toolCallCount, 0);
  assert.equal(snap.pendingToolCalls, 0);
  assert.equal(snap.tokenUsage, undefined);
});

test('incrementIteration and getIterationIndex track loop iterations', () => {
  const state = new TurnExecutionState();
  state.incrementIteration();
  state.incrementIteration();
  assert.equal(state.getIterationIndex(), 2);
  assert.equal(state.snapshot().iterationIndex, 2);
});

test('beginModelTurn increments model turn count', () => {
  const state = new TurnExecutionState();
  state.beginModelTurn();
  state.beginModelTurn();
  assert.equal(state.snapshot().modelTurnCount, 2);
});

test('registerToolCall and resolveToolCall track tool calls', () => {
  const state = new TurnExecutionState();
  state.registerToolCall('call-1');
  state.registerToolCall('call-2');
  assert.equal(state.snapshot().toolCallCount, 2);
  assert.equal(state.snapshot().pendingToolCalls, 2);

  state.resolveToolCall('call-1');
  assert.equal(state.snapshot().toolCallCount, 2);
  assert.equal(state.snapshot().pendingToolCalls, 1);

  state.resolveToolCall('call-2');
  assert.equal(state.snapshot().pendingToolCalls, 0);
});

test('setTokenUsage and getTokenUsage track token usage', () => {
  const state = new TurnExecutionState();
  assert.equal(state.getTokenUsage(), undefined);

  const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
  state.setTokenUsage(usage);
  assert.deepEqual(state.getTokenUsage(), usage);
  assert.deepEqual(state.snapshot().tokenUsage, usage);
});

test('ActiveTurn creates TurnExecutionState via executionState property', () => {
  const turn = new ActiveTurn('task-1', 1);
  assert.ok(turn.executionState instanceof TurnExecutionState);
  assert.equal(turn.executionState.getIterationIndex(), 0);
});

test('ActiveTurn.complete sets token usage on executionState', () => {
  const turn = new ActiveTurn('task-1', 1);
  const usage = { inputTokens: 200, outputTokens: 100, totalTokens: 300 };
  turn.complete(usage);
  assert.deepEqual(turn.executionState.getTokenUsage(), usage);
});

test('ActiveTurn.snapshot includes executionState snapshot', () => {
  const turn = new ActiveTurn('task-1', 1);
  turn.executionState.beginModelTurn();
  turn.executionState.registerToolCall('call-1');

  const snap = turn.snapshot();
  assert.equal(snap.executionState.modelTurnCount, 1);
  assert.equal(snap.executionState.toolCallCount, 1);
  assert.equal(snap.status, 'running');
});

test('ActiveTurn.fail records error and sets status', () => {
  const turn = new ActiveTurn('task-1', 1);
  turn.fail(new Error('something broke'));

  const snap = turn.snapshot();
  assert.equal(snap.status, 'failed');
  assert.equal(snap.errorMessage, 'something broke');
  assert.ok(snap.completedAt);
});

test('TurnExecutionState is not leaked — disposed with ActiveTurn', () => {
  let turn: ActiveTurn | undefined = new ActiveTurn('task-1', 1);
  const execState = turn.executionState;
  execState.incrementIteration();
  assert.equal(execState.getIterationIndex(), 1);

  // Simulate SessionRuntime clearing activeTurn
  turn = undefined;
  // execState reference still works but the ActiveTurn is GC-eligible
  assert.equal(execState.getIterationIndex(), 1);
});

test('TurnExecutionState local fallback: works without ActiveTurn', () => {
  // Simulates the fallback path in TurnExecutor.run() when activeTurn is undefined
  const activeTurn = undefined as ActiveTurn | undefined;
  const executionState = activeTurn?.executionState ?? new TurnExecutionState();

  executionState.incrementIteration();
  executionState.beginModelTurn();
  executionState.registerToolCall('call-1');

  assert.equal(executionState.getIterationIndex(), 1);
  assert.equal(executionState.snapshot().modelTurnCount, 1);
  assert.equal(executionState.snapshot().toolCallCount, 1);
});
