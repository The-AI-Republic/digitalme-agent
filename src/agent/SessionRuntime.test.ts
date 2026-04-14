import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRuntime } from './SessionRuntime.js';
import { SessionState } from './SessionState.js';
import { EventQueue } from './EventQueue.js';
import type { AgentEvent, TurnExecutionResult, TurnSubmission } from './types.js';
import type { ITranscriptRecorder } from './transcript/types.js';
import { generateId } from '../models/ModelClient.js';

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
    newMessages: [
      { role: 'user', content: 'hello', id: generateId() },
      { role: 'assistant', content: 'response', id: generateId() },
    ],
    completedTurns: 1,
    toolCallCount: 0,
    ...overrides,
  };
}

function createMockTranscriptRecorder(): {
  recorder: ITranscriptRecorder;
  lifecycleEvents: Array<{ type: string; [key: string]: unknown }>;
} {
  const lifecycleEvents: Array<{ type: string; [key: string]: unknown }> = [];
  const recorder: ITranscriptRecorder = {
    recordMessage: async () => {},
    recordLifecycleEvent: async (entry: any) => { lifecycleEvents.push(entry); },
    insertMessageChain: async () => {},
    writeAgentMetadata: async () => {},
    loadTranscript: async () => ({ messages: [], leafId: null }),
    seedParentId: () => {},
  };
  return { recorder, lifecycleEvents };
}

function createMockTurnExecutor(result: TurnExecutionResult = makeResult()) {
  return {
    run: async function* (_submission: TurnSubmission) {
      return result;
    },
  };
}

function createDeps(result: TurnExecutionResult = makeResult()) {
  const { recorder, lifecycleEvents } = createMockTranscriptRecorder();
  return {
    lifecycleEvents,
    deps: {
      turnExecutor: createMockTurnExecutor(result),
      transcriptRecorder: recorder,
    },
  };
}

test('successful execution commits to session state', async () => {
  const state = new SessionState('conv-1', []);
  const { deps } = createDeps();
  const runtime = new SessionRuntime(state, deps);
  const events = new EventQueue<AgentEvent>();

  await runtime.execute(makeSubmission(), events);

  const snap = state.snapshot();
  assert.ok(snap.messageCount > 0);
});

test('successful execution records task_started and task_completed lifecycle events', async () => {
  const state = new SessionState('conv-1', []);
  const { deps, lifecycleEvents } = createDeps();
  const runtime = new SessionRuntime(state, deps);
  const events = new EventQueue<AgentEvent>();

  await runtime.execute(makeSubmission(), events);

  const types = lifecycleEvents.map((e) => e.type);
  assert.ok(types.includes('task_started'));
  assert.ok(types.includes('task_completed'));
  assert.ok(!types.includes('task_failed'));
});

test('failed execution records lifecycle events and re-throws', async () => {
  const { recorder, lifecycleEvents } = createMockTranscriptRecorder();
  const state = new SessionState('conv-1', []);
  const runtime = new SessionRuntime(state, {
    turnExecutor: {
      run: async function* () {
        throw new Error('model_exploded');
        // Unreachable — needed only to satisfy TypeScript's generator return type
        return undefined as any;
      },
    },
    transcriptRecorder: recorder,
  });
  const events = new EventQueue<AgentEvent>();

  await assert.rejects(
    () => runtime.execute(makeSubmission(), events),
    { message: 'model_exploded' },
  );

  const types = lifecycleEvents.map((e) => e.type);
  assert.ok(types.includes('task_started'));
  assert.ok(types.includes('task_failed'));
  assert.ok(!types.includes('task_completed'));
});

test('failed execution clears activeTurn', async () => {
  const { recorder } = createMockTranscriptRecorder();
  const state = new SessionState('conv-1', []);
  const runtime = new SessionRuntime(state, {
    turnExecutor: {
      run: async function* () {
        throw new Error('fail');
        return undefined as any;
      },
    },
    transcriptRecorder: recorder,
  });
  const events = new EventQueue<AgentEvent>();

  try { await runtime.execute(makeSubmission(), events); } catch {}

  assert.equal(runtime.hasActiveTurn(), false);
});

test('terminal model_error records task_failed without committing success state', async () => {
  const { recorder, lifecycleEvents } = createMockTranscriptRecorder();
  const state = new SessionState('conv-1', []);
  const runtime = new SessionRuntime(state, {
    turnExecutor: {
      run: async function* () {
        yield { type: 'done', terminalReason: { reason: 'model_error', error: 'boom' } } as AgentEvent;
        return makeResult({
          finalText: '',
          newMessages: [
            { role: 'user', content: 'hello', id: generateId() },
            { role: 'assistant', content: 'should not commit', id: generateId() },
          ],
        });
      },
    },
    transcriptRecorder: recorder,
  });
  const events = new EventQueue<AgentEvent>();

  await runtime.execute(makeSubmission(), events);

  const types = lifecycleEvents.map((e) => e.type);
  assert.ok(types.includes('task_failed'));
  assert.ok(!types.includes('task_completed'));

  const failedEntry = lifecycleEvents.find((e: any) => e.type === 'task_failed') as any;
  assert.equal(failedEntry.turn.status, 'failed');

  const snap = state.snapshot();
  assert.equal(snap.messageCount, 0);
});

test('reconcileWithPlatformHistory reseeded triggers lifecycle recording', async () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'old' },
  ]);
  const { deps, lifecycleEvents } = createDeps();
  const runtime = new SessionRuntime(state, deps);
  const events = new EventQueue<AgentEvent>();

  await runtime.execute(makeSubmission({
    history: [
      { role: 'user', content: 'new-history' },
      { role: 'assistant', content: 'new-response' },
    ],
  }), events);

  const types = lifecycleEvents.map((e) => e.type);
  assert.ok(types.includes('session_reseeded'));
});

test('warm reconciliation does not record session_reseeded', async () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'existing' },
  ]);
  const { deps, lifecycleEvents } = createDeps();
  const runtime = new SessionRuntime(state, deps);
  const events = new EventQueue<AgentEvent>();

  await runtime.execute(makeSubmission({ history: [] }), events);

  const types = lifecycleEvents.map((e) => e.type);
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
  const { recorder, lifecycleEvents } = createMockTranscriptRecorder();
  const deps = {
    turnExecutor: createMockTurnExecutor(),
    transcriptRecorder: recorder,
  };
  const state = new SessionState('conv-1', []);
  const runtime = new SessionRuntime(state, deps);

  await runtime.execute(makeSubmission({ requestId: 'r1' }), new EventQueue<AgentEvent>());
  await runtime.execute(makeSubmission({ requestId: 'r2' }), new EventQueue<AgentEvent>());

  const startedEntries = lifecycleEvents.filter((e) => e.type === 'task_started');
  assert.equal((startedEntries[0] as any).turnId, 1);
  assert.equal((startedEntries[1] as any).turnId, 2);
});
