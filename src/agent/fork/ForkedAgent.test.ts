import test from 'node:test';
import assert from 'node:assert/strict';

import { ForkSemaphore } from './ForkSemaphore.js';
import { launchForkedAgent } from './ForkedAgent.js';
import type {
  AgentEvent,
  TurnExecutionResult,
  TurnSubmission,
  ForkedAgentHandle,
  ForkedAgentResult,
} from '../types.js';

function makeFakeExecutor(finalText: string, tokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }) {
  return {
    async *run(submission: TurnSubmission): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      yield { type: 'text_delta' as const, content: finalText };
      yield { type: 'done' as const, tokenUsage };
      return {
        finalText,
        tokenUsage,
        completedTurns: 1,
        toolCallCount: 0,
        promptMessages: [],
      };
    },
  };
}

function makeAbortingExecutor() {
  return {
    async *run(submission: TurnSubmission): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      if (submission.signal?.aborted) {
        throw new Error('request_aborted');
      }
      // Simulate work that checks abort
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (submission.signal?.aborted) {
        throw new Error('request_aborted');
      }
      yield { type: 'done' as const };
      return {
        finalText: '',
        completedTurns: 1,
        toolCallCount: 0,
        promptMessages: [],
      };
    },
  };
}

function makeFailingExecutor(error: string) {
  return {
    async *run(): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      throw new Error(error);
    },
  };
}

function makeSubmission(overrides: Partial<TurnSubmission> = {}): TurnSubmission {
  return {
    requestId: 'req-fork',
    conversationId: 'conv-fork',
    userMessage: '',
    history: [],
    ...overrides,
  };
}

function makeRuntime() {
  const handles: ForkedAgentHandle[] = [];
  return {
    handles,
    registerForkedAgent(handle: ForkedAgentHandle) {
      handles.push(handle);
    },
  };
}

// --- ForkSemaphore tests ---

test('ForkSemaphore.tryAcquire returns false when full', () => {
  const sem = new ForkSemaphore(1);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.tryAcquire(), false);
});

test('ForkSemaphore.release allows reacquire', () => {
  const sem = new ForkSemaphore(1);
  sem.tryAcquire();
  sem.release();
  assert.equal(sem.tryAcquire(), true);
});

test('ForkSemaphore.release does not go below zero', () => {
  const sem = new ForkSemaphore(1);
  sem.release();
  assert.equal(sem.getRunning(), 0);
});

// --- launchForkedAgent tests ---

test('launchForkedAgent returns ForkedAgentResult with finalText and totalUsage', async () => {
  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeFakeExecutor('hello from fork'),
    forkSemaphore: new ForkSemaphore(2),
    sessionRuntime: makeRuntime(),
    config: { forkLabel: 'test' },
  });

  assert.ok(handle);
  const result = await handle.promise;
  assert.equal(result.finalText, 'hello from fork');
  assert.equal(result.totalUsage.totalTokens, 15);
});

test('launchForkedAgent returns null when semaphore is full', () => {
  const sem = new ForkSemaphore(1);
  sem.tryAcquire(); // fill it

  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeFakeExecutor('ignored'),
    forkSemaphore: sem,
    sessionRuntime: makeRuntime(),
    config: { forkLabel: 'test' },
  });

  assert.equal(handle, null);
});

test('launchForkedAgent invokes onResult on success', async () => {
  const results: ForkedAgentResult[] = [];

  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeFakeExecutor('success'),
    forkSemaphore: new ForkSemaphore(2),
    sessionRuntime: makeRuntime(),
    config: { forkLabel: 'test' },
    onResult: (result) => { results.push(result); },
  });

  assert.ok(handle);
  await handle.promise;
  assert.equal(results.length, 1);
  assert.equal(results[0]?.finalText, 'success');
});

test('launchForkedAgent does NOT invoke onResult on error', async () => {
  let called = false;

  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeFailingExecutor('boom'),
    forkSemaphore: new ForkSemaphore(2),
    sessionRuntime: makeRuntime(),
    config: { forkLabel: 'test' },
    onResult: () => { called = true; },
  });

  assert.ok(handle);
  await assert.rejects(() => handle.promise, /boom/);
  assert.equal(called, false);
});

test('launchForkedAgent releases semaphore on success', async () => {
  const sem = new ForkSemaphore(1);

  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeFakeExecutor('ok'),
    forkSemaphore: sem,
    sessionRuntime: makeRuntime(),
    config: { forkLabel: 'test' },
  });

  assert.ok(handle);
  assert.equal(sem.getRunning(), 1);
  await handle.promise;
  assert.equal(sem.getRunning(), 0);
});

test('launchForkedAgent releases semaphore on error', async () => {
  const sem = new ForkSemaphore(1);

  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeFailingExecutor('crash'),
    forkSemaphore: sem,
    sessionRuntime: makeRuntime(),
    config: { forkLabel: 'test' },
  });

  assert.ok(handle);
  await handle.promise.catch(() => {});
  assert.equal(sem.getRunning(), 0);
});

test('launchForkedAgent releases semaphore on abort', async () => {
  const sem = new ForkSemaphore(1);
  const parentAbort = new AbortController();

  const handle = launchForkedAgent({
    submission: makeSubmission({ signal: parentAbort.signal }),
    turnExecutor: makeAbortingExecutor(),
    forkSemaphore: sem,
    sessionRuntime: makeRuntime(),
    config: { forkLabel: 'test' },
  });

  assert.ok(handle);
  handle.abort();
  await handle.promise.catch(() => {});
  assert.equal(sem.getRunning(), 0);
});

test('launchForkedAgent registers handle on sessionRuntime', async () => {
  const runtime = makeRuntime();

  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: makeFakeExecutor('ok'),
    forkSemaphore: new ForkSemaphore(2),
    sessionRuntime: runtime,
    config: { forkLabel: 'my_fork' },
  });

  assert.ok(handle);
  assert.equal(runtime.handles.length, 1);
  assert.equal(runtime.handles[0]?.forkLabel, 'my_fork');
  assert.ok(runtime.handles[0]?.id.startsWith('fork-my_fork-'));
});

test('launchForkedAgent child abort fires when parent aborts', async () => {
  const parentAbort = new AbortController();

  const handle = launchForkedAgent({
    submission: makeSubmission({ signal: parentAbort.signal }),
    turnExecutor: makeAbortingExecutor(),
    forkSemaphore: new ForkSemaphore(2),
    sessionRuntime: makeRuntime(),
    config: { forkLabel: 'test' },
  });

  assert.ok(handle);
  parentAbort.abort();
  await assert.rejects(() => handle.promise, /request_aborted/);
});

test('launchForkedAgent passes ExecutionOptions through to run()', async () => {
  let receivedModel: string | undefined;
  const executor = {
    async *run(
      _submission: TurnSubmission,
      options?: { model?: string },
    ): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      receivedModel = options?.model;
      yield { type: 'done' as const };
      return { finalText: '', completedTurns: 1, toolCallCount: 0, promptMessages: [] };
    },
  };

  const handle = launchForkedAgent({
    submission: makeSubmission(),
    turnExecutor: executor,
    options: { model: 'gpt-4o-mini', maxTurns: 3 },
    forkSemaphore: new ForkSemaphore(2),
    sessionRuntime: makeRuntime(),
    config: { forkLabel: 'test' },
  });

  assert.ok(handle);
  await handle.promise;
  assert.equal(receivedModel, 'gpt-4o-mini');
});
