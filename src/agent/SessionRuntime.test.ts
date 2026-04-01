import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRuntime } from './SessionRuntime.js';
import { SessionState } from './SessionState.js';
import { EventQueue } from './EventQueue.js';
import type { AgentEvent, TurnExecutionResult, TurnSubmission } from './types.js';
import type { RolloutEntry } from './RolloutRecorder.js';

function makeSubmission(overrides: Partial<TurnSubmission> = {}): TurnSubmission {
  return {
    requestId: 'req-1',
    conversationId: 'conv-1',
    userMessage: 'hello',
    history: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<TurnExecutionResult> = {}): TurnExecutionResult {
  return {
    finalText: 'response',
    promptMessages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'response' },
    ],
    completedTurns: 1,
    toolCallCount: 0,
    ...overrides,
  };
}

function createDeps(result: TurnExecutionResult = makeResult()) {
  const recorded: RolloutEntry[] = [];
  return {
    recorded,
    deps: {
      turnExecutor: {
        run: async () => result,
      },
      rolloutRecorder: {
        record: async (entry: RolloutEntry) => { recorded.push(entry); },
      },
    },
  };
}

test('successful execution commits to session state', async () => {
  const state = new SessionState('conv-1', []);
  const { deps } = createDeps();
  const runtime = new SessionRuntime(state, deps);
  const events = new EventQueue<AgentEvent>();

  await runtime.execute(makeSubmission(), events);

  const history = state.getCanonicalHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].role, 'user');
  assert.equal(history[0].content, 'hello');
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].content, 'response');
});

test('successful execution records task_started and task_completed rollouts', async () => {
  const state = new SessionState('conv-1', []);
  const { deps, recorded } = createDeps();
  const runtime = new SessionRuntime(state, deps);
  const events = new EventQueue<AgentEvent>();

  await runtime.execute(makeSubmission(), events);

  const types = recorded.map((r) => r.type);
  assert.ok(types.includes('task_started'));
  assert.ok(types.includes('task_completed'));
  assert.ok(!types.includes('task_failed'));
});

test('failed execution records rollout and re-throws', async () => {
  const state = new SessionState('conv-1', []);
  const recorded: RolloutEntry[] = [];
  const runtime = new SessionRuntime(state, {
    turnExecutor: {
      run: async () => { throw new Error('model_exploded'); },
    },
    rolloutRecorder: {
      record: async (entry: RolloutEntry) => { recorded.push(entry); },
    },
  });
  const events = new EventQueue<AgentEvent>();

  await assert.rejects(
    () => runtime.execute(makeSubmission(), events),
    { message: 'model_exploded' },
  );

  const types = recorded.map((r) => r.type);
  assert.ok(types.includes('task_started'));
  assert.ok(types.includes('task_failed'));
  assert.ok(!types.includes('task_completed'));

  // Session state should NOT have been committed
  assert.equal(state.getCanonicalHistory().length, 0);
});

test('failed execution clears activeTurn', async () => {
  const state = new SessionState('conv-1', []);
  const runtime = new SessionRuntime(state, {
    turnExecutor: {
      run: async () => { throw new Error('fail'); },
    },
    rolloutRecorder: { record: async () => {} },
  });
  const events = new EventQueue<AgentEvent>();

  try { await runtime.execute(makeSubmission(), events); } catch {}

  assert.equal(runtime.hasActiveTurn(), false);
});

test('reconcileWithPlatformHistory reseeded triggers rollout recording', async () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'old' },
  ]);
  const { deps, recorded } = createDeps();
  const runtime = new SessionRuntime(state, deps);
  const events = new EventQueue<AgentEvent>();

  // Send different history to trigger reseed
  await runtime.execute(makeSubmission({
    history: [
      { role: 'user', content: 'new-history' },
      { role: 'assistant', content: 'new-response' },
    ],
  }), events);

  const types = recorded.map((r) => r.type);
  assert.ok(types.includes('session_reseeded'));
});

test('warm reconciliation does not record session_reseeded', async () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'existing' },
  ]);
  const { deps, recorded } = createDeps();
  const runtime = new SessionRuntime(state, deps);
  const events = new EventQueue<AgentEvent>();

  // Empty history with existing local data → warm
  await runtime.execute(makeSubmission({ history: [] }), events);

  const types = recorded.map((r) => r.type);
  assert.ok(!types.includes('session_reseeded'));
});

test('snapshot includes session and no active turn when idle', async () => {
  const state = new SessionState('conv-1', []);
  const { deps } = createDeps();
  const runtime = new SessionRuntime(state, deps);

  const snap = runtime.snapshot();
  assert.equal(snap.session.conversationId, 'conv-1');
  assert.equal(snap.activeTurn, undefined);
});

test('turn id increments across executions', async () => {
  const state = new SessionState('conv-1', []);
  const recorded: RolloutEntry[] = [];
  const deps = {
    turnExecutor: { run: async () => makeResult() },
    rolloutRecorder: { record: async (entry: RolloutEntry) => { recorded.push(entry); } },
  };
  const runtime = new SessionRuntime(state, deps);

  await runtime.execute(makeSubmission({ requestId: 'r1' }), new EventQueue<AgentEvent>());
  await runtime.execute(makeSubmission({ requestId: 'r2' }), new EventQueue<AgentEvent>());

  const startedEntries = recorded.filter((r) => r.type === 'task_started');
  assert.equal(startedEntries[0].turnId, 1);
  assert.equal(startedEntries[1].turnId, 2);
});
