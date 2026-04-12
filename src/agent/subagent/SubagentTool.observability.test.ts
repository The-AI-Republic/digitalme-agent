import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentTool } from './SubagentTool.js';
import type { AgentEvent, TurnExecutionResult, TurnSubmission } from '../types.js';
import type { ITranscriptRecorder, TranscriptEntry, SubagentCompletedEntry, SubagentFailedEntry, SubagentStartedEntry } from '../transcript/types.js';
import type { IToolRegistry } from '../../tools/registry.js';
import type { ToolContext } from '../../tools/types.js';
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
  };
  return { recorder, entries };
}

function makeToolRegistry(): IToolRegistry {
  return {
    listDefinitions: () => [],
    listNames: () => [],
    get: () => undefined,
  };
}

function makeSuccessExecutor() {
  return {
    async *run(_sub: TurnSubmission): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      return {
        finalText: 'agent done',
        tokenUsage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        completedTurns: 2,
        toolCallCount: 3,
        newMessages: [],
      };
    },
  };
}

function makeFailingExecutor() {
  return {
    async *run(_sub: TurnSubmission): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      throw new Error('subagent crash');
    },
  };
}

function makeToolContext(): ToolContext {
  return {
    conversationId: 'conv-1',
    signal: new AbortController().signal,
    policyConfig: {},
  };
}

test('subagent tool records subagent_started on launch', async () => {
  const { recorder, entries } = makeRecorder();

  const tool = createSubagentTool({
    turnExecutor: makeSuccessExecutor(),
    parentToolRegistry: makeToolRegistry(),
    modelName: 'gpt-4',
    transcriptRecorder: recorder,
  });

  await tool.execute(
    { description: 'test', prompt: 'do stuff', subagent_type: 'general-purpose' },
    makeToolContext(),
  );

  await new Promise((r) => setTimeout(r, 50));

  const started = entries.find((e) => e.type === 'subagent_started') as SubagentStartedEntry | undefined;
  assert.ok(started, 'Expected subagent_started entry');
  assert.equal(started.subagentType, 'general-purpose');
  assert.equal(started.model, 'gpt-4');
});

test('subagent tool records subagent_completed on success', async () => {
  const { recorder, entries } = makeRecorder();

  const tool = createSubagentTool({
    turnExecutor: makeSuccessExecutor(),
    parentToolRegistry: makeToolRegistry(),
    modelName: 'gpt-4',
    transcriptRecorder: recorder,
  });

  const result = await tool.execute(
    { description: 'test', prompt: 'do stuff', subagent_type: 'general-purpose' },
    makeToolContext(),
  );

  await new Promise((r) => setTimeout(r, 50));

  assert.equal(result.success, true);

  const completed = entries.find((e) => e.type === 'subagent_completed') as SubagentCompletedEntry | undefined;
  assert.ok(completed, 'Expected subagent_completed entry');
  assert.equal(completed.subagentType, 'general-purpose');
  assert.equal(completed.model, 'gpt-4');
  assert.equal(completed.toolCallCount, 3);
  assert.equal(completed.completedTurns, 2);
  assert.ok(completed.durationMs >= 0);
  assert.deepEqual(completed.tokenUsage, { inputTokens: 200, outputTokens: 100, totalTokens: 300 });
});

test('subagent tool records subagent_failed on error', async () => {
  const { recorder, entries } = makeRecorder();

  const tool = createSubagentTool({
    turnExecutor: makeFailingExecutor(),
    parentToolRegistry: makeToolRegistry(),
    modelName: 'gpt-4',
    transcriptRecorder: recorder,
  });

  const result = await tool.execute(
    { description: 'test', prompt: 'do stuff', subagent_type: 'general-purpose' },
    makeToolContext(),
  );

  await new Promise((r) => setTimeout(r, 50));

  assert.equal(result.success, false);

  const failed = entries.find((e) => e.type === 'subagent_failed') as SubagentFailedEntry | undefined;
  assert.ok(failed, 'Expected subagent_failed entry');
  assert.equal(failed.subagentType, 'general-purpose');
  assert.equal(failed.error, 'subagent crash');
});

test('subagent tool works without recorder', async () => {
  const tool = createSubagentTool({
    turnExecutor: makeSuccessExecutor(),
    parentToolRegistry: makeToolRegistry(),
    modelName: 'gpt-4',
    // no transcriptRecorder
  });

  const result = await tool.execute(
    { description: 'test', prompt: 'do stuff', subagent_type: 'general-purpose' },
    makeToolContext(),
  );

  assert.equal(result.success, true);
});

test('subagent tool returns error for unknown agent type', async () => {
  const { recorder, entries } = makeRecorder();

  const tool = createSubagentTool({
    turnExecutor: makeSuccessExecutor(),
    parentToolRegistry: makeToolRegistry(),
    modelName: 'gpt-4',
    transcriptRecorder: recorder,
  });

  const result = await tool.execute(
    { description: 'test', prompt: 'do stuff', subagent_type: 'nonexistent-agent' },
    makeToolContext(),
  );

  assert.equal(result.success, false);
  // No lifecycle events should be recorded for unknown agent type
  const lifecycleEntries = entries.filter((e) =>
    e.type === 'subagent_started' || e.type === 'subagent_completed' || e.type === 'subagent_failed',
  );
  assert.equal(lifecycleEntries.length, 0);
});
