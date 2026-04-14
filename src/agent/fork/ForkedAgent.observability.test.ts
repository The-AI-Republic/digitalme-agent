import test from 'node:test';
import assert from 'node:assert/strict';
import { launchForkedAgent } from './ForkedAgent.js';
import type { ForkedAgentHandle, AgentEvent, TurnExecutionResult, TurnSubmission } from '../types.js';
import type { ITranscriptRecorder, TranscriptEntry } from '../transcript/types.js';
import type { Message } from '../../models/ModelClient.js';
import { ForkSemaphore } from './ForkSemaphore.js';

function makeSubmission(): TurnSubmission {
  return {
    requestId: 'req-1',
    conversationId: 'conv-1',
    userMessage: 'test',
    history: [],
  };
}

function makeSuccessResult(): TurnExecutionResult {
  return {
    finalText: 'done',
    tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    completedTurns: 1,
    toolCallCount: 2,
    newMessages: [],
  };
}

function makeFailResult(): TurnExecutionResult {
  throw new Error('model failure');
}

function makeTurnExecutor(resultFn: () => TurnExecutionResult) {
  return {
    async *run(_sub: TurnSubmission): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      return resultFn();
    },
  };
}

function makeRecorder(): { recorder: ITranscriptRecorder; entries: TranscriptEntry[] } {
  const entries: TranscriptEntry[] = [];
  const recorder: ITranscriptRecorder = {
    async recordMessage() {},
    async recordLifecycleEvent(entry: TranscriptEntry) {
      entries.push(entry);
    },
    async insertMessageChain() {},
    async loadTranscript() { return { messages: [] as Message[], leafId: null }; },
    seedParentId() {},
    async writeAgentMetadata() {},
  };
  return { recorder, entries };
}

test('launchForkedAgent records fork_started on launch', async () => {
  const { recorder, entries } = makeRecorder();
  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeTurnExecutor(makeSuccessResult),
    sessionRuntime: { canFork: () => true, registerForkedAgent: () => {} },
    forkSemaphore: new ForkSemaphore(2),
    config: { forkLabel: 'test_fork' },
    transcriptRecorder: recorder,
  });

  assert.ok(handle);
  await handle.promise;

  // Wait for async recording
  await new Promise((r) => setTimeout(r, 50));

  const started = entries.find((e) => e.type === 'fork_started');
  assert.ok(started, 'Expected fork_started entry');
  assert.equal((started as any).forkLabel, 'test_fork');
});

test('launchForkedAgent records fork_completed on success', async () => {
  const { recorder, entries } = makeRecorder();
  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeTurnExecutor(makeSuccessResult),
    sessionRuntime: { canFork: () => true, registerForkedAgent: () => {} },
    forkSemaphore: new ForkSemaphore(2),
    config: { forkLabel: 'test_fork' },
    transcriptRecorder: recorder,
  });

  assert.ok(handle);
  await handle.promise;
  await new Promise((r) => setTimeout(r, 50));

  const completed = entries.find((e) => e.type === 'fork_completed');
  assert.ok(completed, 'Expected fork_completed entry');
  assert.equal((completed as any).forkLabel, 'test_fork');
  assert.equal((completed as any).toolCallCount, 2);
  assert.ok((completed as any).durationMs >= 0);
  assert.deepEqual((completed as any).tokenUsage, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
});

test('launchForkedAgent records fork_failed on error', async () => {
  const { recorder, entries } = makeRecorder();
  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeTurnExecutor(makeFailResult),
    sessionRuntime: { canFork: () => true, registerForkedAgent: () => {} },
    forkSemaphore: new ForkSemaphore(2),
    config: { forkLabel: 'test_fork' },
    transcriptRecorder: recorder,
  });

  assert.ok(handle);
  // handle.promise will reject, but the error is suppressed by the catch(() => {})
  try { await handle.promise; } catch { /* expected */ }
  await new Promise((r) => setTimeout(r, 50));

  const failed = entries.find((e) => e.type === 'fork_failed');
  assert.ok(failed, 'Expected fork_failed entry');
  assert.equal((failed as any).forkLabel, 'test_fork');
  assert.equal((failed as any).error, 'model failure');
});

test('launchForkedAgent records fork_rejected when forks disabled', async () => {
  const { recorder, entries } = makeRecorder();
  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeTurnExecutor(makeSuccessResult),
    sessionRuntime: { canFork: () => false, registerForkedAgent: () => {} },
    forkSemaphore: new ForkSemaphore(2),
    config: { forkLabel: 'test_fork' },
    transcriptRecorder: recorder,
  });

  assert.equal(handle, null);
  await new Promise((r) => setTimeout(r, 50));

  const rejected = entries.find((e) => e.type === 'fork_rejected');
  assert.ok(rejected, 'Expected fork_rejected entry');
  assert.equal((rejected as any).forkLabel, 'test_fork');
  assert.equal((rejected as any).reason, 'forks_disabled');
});

test('launchForkedAgent records fork_rejected when semaphore full', async () => {
  const { recorder, entries } = makeRecorder();
  const semaphore = new ForkSemaphore(0); // no slots

  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeTurnExecutor(makeSuccessResult),
    sessionRuntime: { canFork: () => true, registerForkedAgent: () => {} },
    forkSemaphore: semaphore,
    config: { forkLabel: 'test_fork' },
    transcriptRecorder: recorder,
  });

  assert.equal(handle, null);
  await new Promise((r) => setTimeout(r, 50));

  const rejected = entries.find((e) => e.type === 'fork_rejected');
  assert.ok(rejected, 'Expected fork_rejected entry');
  assert.equal((rejected as any).reason, 'semaphore_full');
});

test('launchForkedAgent works without recorder', async () => {
  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeTurnExecutor(makeSuccessResult),
    sessionRuntime: { canFork: () => true, registerForkedAgent: () => {} },
    forkSemaphore: new ForkSemaphore(2),
    config: { forkLabel: 'test_fork' },
    // no transcriptRecorder
  });

  assert.ok(handle);
  const result = await handle.promise;
  assert.equal(result.finalText, 'done');
});
