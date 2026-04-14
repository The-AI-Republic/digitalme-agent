import assert from 'node:assert/strict';
import test from 'node:test';
import { ActiveTurn } from './ActiveTurn.js';

test('initial state is running', () => {
  const turn = new ActiveTurn('task-1', 1);
  const snap = turn.snapshot();
  assert.equal(snap.status, 'running');
  assert.equal(snap.taskId, 'task-1');
  assert.equal(snap.turnId, 1);
  assert.equal(snap.completedAt, undefined);
  assert.equal(snap.errorMessage, undefined);
});

test('complete sets status to completed', () => {
  const turn = new ActiveTurn('task-1', 1);
  turn.complete({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  const snap = turn.snapshot();
  assert.equal(snap.status, 'completed');
  assert.ok(snap.completedAt);
  assert.deepEqual(snap.turnState.tokenUsage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
});

test('complete without token usage', () => {
  const turn = new ActiveTurn('task-1', 1);
  turn.complete();
  const snap = turn.snapshot();
  assert.equal(snap.status, 'completed');
  assert.equal(snap.turnState.tokenUsage, undefined);
});

test('fail sets status and error message from Error', () => {
  const turn = new ActiveTurn('task-1', 1);
  turn.fail(new Error('something broke'));
  const snap = turn.snapshot();
  assert.equal(snap.status, 'failed');
  assert.equal(snap.errorMessage, 'something broke');
  assert.ok(snap.completedAt);
});

test('fail handles non-Error values', () => {
  const turn = new ActiveTurn('task-1', 1);
  turn.fail('string error');
  const snap = turn.snapshot();
  assert.equal(snap.status, 'failed');
  assert.equal(snap.errorMessage, 'string error');
});
