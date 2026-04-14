import test from 'node:test';
import assert from 'node:assert/strict';
import { PostTurnHookRegistry, HookTimeoutError, SLOW_HOOK_THRESHOLD_MS } from './PostTurnHooks.js';
import type { PostTurnHookContext } from './PostTurnHooks.js';
import type { ITranscriptRecorder, TranscriptEntry, HookExecutedEntry } from '../transcript/types.js';
import type { Message } from '../../models/ModelClient.js';

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

function makeFakeContext(recorder?: ITranscriptRecorder): PostTurnHookContext {
  return {
    sessionState: {} as PostTurnHookContext['sessionState'],
    sessionRuntime: { canFork() { return true; }, registerForkedAgent() {} },
    forkSemaphore: {} as PostTurnHookContext['forkSemaphore'],
    turnExecutor: {} as PostTurnHookContext['turnExecutor'],
    conversationId: 'conv-test',
    lastResult: {
      finalText: 'done',
      completedTurns: 1,
      toolCallCount: 0,
      newMessages: [],
    },
    transcriptRecorder: recorder,
  };
}

test('HookTimeoutError has correct name and message', () => {
  const error = new HookTimeoutError();
  assert.equal(error.name, 'HookTimeoutError');
  assert.equal(error.message, 'Hook execution timed out');
  assert.ok(error instanceof Error);
  assert.ok(error instanceof HookTimeoutError);
});

test('SLOW_HOOK_THRESHOLD_MS is 2000', () => {
  assert.equal(SLOW_HOOK_THRESHOLD_MS, 2000);
});

test('hook_executed entry recorded on success', async () => {
  const { recorder, entries } = makeRecorder();
  const registry = new PostTurnHookRegistry();

  registry.register(async () => {}, 'test_hook');
  await registry.runAll(makeFakeContext(recorder));

  const hookEntry = entries.find((e) => e.type === 'hook_executed') as HookExecutedEntry | undefined;
  assert.ok(hookEntry, 'Expected hook_executed entry');
  assert.equal(hookEntry.hookName, 'test_hook');
  assert.equal(hookEntry.outcome, 'success');
  assert.ok(hookEntry.durationMs >= 0);
  assert.equal(hookEntry.error, undefined);
});

test('hook_executed entry recorded on error with correct outcome', async () => {
  const { recorder, entries } = makeRecorder();
  const registry = new PostTurnHookRegistry();

  registry.register(async () => { throw new Error('hook crash'); }, 'crashing_hook');
  await registry.runAll(makeFakeContext(recorder));

  const hookEntry = entries.find((e) => e.type === 'hook_executed') as HookExecutedEntry | undefined;
  assert.ok(hookEntry, 'Expected hook_executed entry');
  assert.equal(hookEntry.hookName, 'crashing_hook');
  assert.equal(hookEntry.outcome, 'error');
  assert.equal(hookEntry.error, 'hook crash');
});

test('hook_executed entry recorded on timeout with correct outcome', async () => {
  const { recorder, entries } = makeRecorder();
  const registry = new PostTurnHookRegistry(50); // 50ms timeout

  registry.register(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }, 'slow_hook');
  await registry.runAll(makeFakeContext(recorder));

  const hookEntry = entries.find((e) => e.type === 'hook_executed') as HookExecutedEntry | undefined;
  assert.ok(hookEntry, 'Expected hook_executed entry');
  assert.equal(hookEntry.hookName, 'slow_hook');
  assert.equal(hookEntry.outcome, 'timeout');
  assert.equal(hookEntry.error, 'Hook execution timed out');
});

test('timeout uses HookTimeoutError, not string matching', async () => {
  const { recorder, entries } = makeRecorder();
  const registry = new PostTurnHookRegistry(50);

  // Register a hook that throws a generic error with 'timeout' in the message
  // This should be classified as 'error', not 'timeout'
  registry.register(async () => { throw new Error('some timeout happened'); }, 'confusing_hook');
  await registry.runAll(makeFakeContext(recorder));

  const hookEntry = entries.find((e) => e.type === 'hook_executed') as HookExecutedEntry | undefined;
  assert.ok(hookEntry);
  assert.equal(hookEntry.outcome, 'error'); // NOT timeout — instanceof check, not string matching
  assert.equal(hookEntry.error, 'some timeout happened');
});

test('multiple hooks all get recorded', async () => {
  const { recorder, entries } = makeRecorder();
  const registry = new PostTurnHookRegistry();

  registry.register(async () => {}, 'hook_a');
  registry.register(async () => {}, 'hook_b');
  registry.register(async () => { throw new Error('fail'); }, 'hook_c');
  await registry.runAll(makeFakeContext(recorder));

  const hookEntries = entries.filter((e) => e.type === 'hook_executed') as HookExecutedEntry[];
  assert.equal(hookEntries.length, 3);
  assert.equal(hookEntries[0].hookName, 'hook_a');
  assert.equal(hookEntries[0].outcome, 'success');
  assert.equal(hookEntries[1].hookName, 'hook_b');
  assert.equal(hookEntries[1].outcome, 'success');
  assert.equal(hookEntries[2].hookName, 'hook_c');
  assert.equal(hookEntries[2].outcome, 'error');
});

test('recording failure does not crash the agent', async () => {
  const failingRecorder: ITranscriptRecorder = {
    async recordMessage() {},
    async recordLifecycleEvent() { throw new Error('disk full'); },
    async insertMessageChain() {},
    async loadTranscript() { return { messages: [] as Message[], leafId: null }; },
    seedParentId() {},
    async writeAgentMetadata() {},
  };

  const registry = new PostTurnHookRegistry();
  registry.register(async () => {}, 'safe_hook');

  // Should not throw even though recorder fails
  await assert.doesNotReject(() => registry.runAll(makeFakeContext(failingRecorder)));
});

test('hooks use auto-generated names when not provided', async () => {
  const { recorder, entries } = makeRecorder();
  const registry = new PostTurnHookRegistry();

  registry.register(async () => {}); // no name provided
  await registry.runAll(makeFakeContext(recorder));

  const hookEntry = entries.find((e) => e.type === 'hook_executed') as HookExecutedEntry | undefined;
  assert.ok(hookEntry);
  assert.equal(hookEntry.hookName, 'hook_0');
});
