import test from 'node:test';
import assert from 'node:assert/strict';

import { createSubagentTool, resolveSubagentTools } from './SubagentTool.js';
import type { AgentDefinition } from './AgentDefinition.js';
import type { IToolRegistry } from '../../tools/registry.js';
import type {
  AgentEvent,
  ExecutionOptions,
  TurnExecutionResult,
  TurnSubmission,
} from '../types.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { Message } from '../../models/ModelClient.js';
import { generateId } from '../../models/ModelClient.js';
import type { ITranscriptRecorder, AgentMetadata } from '../transcript/types.js';

function makeToolDef(name: string): ToolDefinition {
  return {
    type: 'function',
    function: { name, description: `Tool ${name}`, parameters: {} },
  };
}

function makeParentRegistry(names: string[]): IToolRegistry {
  return {
    listDefinitions() { return names.map(makeToolDef); },
    listNames() { return names; },
    get(name: string) {
      if (names.includes(name)) {
        return {
          name,
          definition: makeToolDef(name),
          metadata: { timeoutMs: 10_000, maxResultChars: 20_000, policyCategory: 'search' as const },
          inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }), parse: (v: unknown) => v } as any,
          async execute() { return { success: true, data: {}, renderForModel: () => 'ok' }; },
        };
      }
      return undefined;
    },
  };
}

function makeFakeExecutor(finalText = 'subagent result') {
  const calls: Array<{ submission: TurnSubmission; options?: ExecutionOptions }> = [];
  return {
    calls,
    async *run(
      submission: TurnSubmission,
      options?: ExecutionOptions,
    ): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      calls.push({ submission, options });
      yield { type: 'done' as const };
      return {
        finalText,
        completedTurns: 1,
        toolCallCount: 0,
        newMessages: [],
      };
    },
  };
}

// --- resolveSubagentTools tests ---

test('resolveSubagentTools with "*" inherits all parent tools', () => {
  const parent = makeParentRegistry(['toolA', 'toolB', 'toolC']);
  const def: AgentDefinition = {
    agentType: 'test',
    whenToUse: 'test',
    tools: '*',
    maxTurns: 10,
    model: 'inherit',
    getSystemPrompt: () => '',
  };

  const resolved = resolveSubagentTools(def, parent);
  assert.deepEqual(resolved.listNames().sort(), ['toolA', 'toolB', 'toolC']);
});

test('resolveSubagentTools with explicit list intersects with parent', () => {
  const parent = makeParentRegistry(['toolA', 'toolB']);
  const def: AgentDefinition = {
    agentType: 'test',
    whenToUse: 'test',
    tools: ['toolA', 'toolC'],  // toolC doesn't exist in parent
    maxTurns: 10,
    model: 'inherit',
    getSystemPrompt: () => '',
  };

  const resolved = resolveSubagentTools(def, parent);
  assert.deepEqual(resolved.listNames(), ['toolA']);
});

test('resolveSubagentTools applies disallowedTools', () => {
  const parent = makeParentRegistry(['toolA', 'toolB', 'toolC']);
  const def: AgentDefinition = {
    agentType: 'test',
    whenToUse: 'test',
    tools: '*',
    disallowedTools: ['toolB'],
    maxTurns: 10,
    model: 'inherit',
    getSystemPrompt: () => '',
  };

  const resolved = resolveSubagentTools(def, parent);
  assert.deepEqual(resolved.listNames().sort(), ['toolA', 'toolC']);
  assert.equal(resolved.get('toolB'), undefined);
});

// --- createSubagentTool tests ---

test('SubagentTool spawns with specified agent type and returns result', async () => {
  const executor = makeFakeExecutor('hello from subagent');
  const tool = createSubagentTool({
    turnExecutor: executor,
    parentToolRegistry: makeParentRegistry([]),
    modelName: 'gpt-4o',
  });

  const result = await tool.execute(
    {
      description: 'test task',
      prompt: 'do something',
      subagent_type: 'general-purpose',
    },
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(result.success, true);
  assert.equal(result.renderForModel(), 'hello from subagent');
});

test('SubagentTool returns error for unknown agent type', async () => {
  const executor = makeFakeExecutor();
  const tool = createSubagentTool({
    turnExecutor: executor,
    parentToolRegistry: makeParentRegistry([]),
    modelName: 'gpt-4o',
  });

  const result = await tool.execute(
    {
      description: 'test',
      prompt: 'do something',
      subagent_type: 'nonexistent',
    },
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(result.success, false);
  assert.ok(result.renderForModel().includes('Unknown agent type'));
});

test('SubagentTool passes model override via ExecutionOptions', async () => {
  const executor = makeFakeExecutor();
  const tool = createSubagentTool({
    turnExecutor: executor,
    parentToolRegistry: makeParentRegistry([]),
    modelName: 'gpt-4o',
  });

  await tool.execute(
    {
      description: 'test',
      prompt: 'do something',
      subagent_type: 'general-purpose',
      model: 'gpt-4o-mini',
    },
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(executor.calls[0]?.options?.model, 'gpt-4o-mini');
});

test('SubagentTool inherits parent model when agent def says inherit', async () => {
  const executor = makeFakeExecutor();
  const tool = createSubagentTool({
    turnExecutor: executor,
    parentToolRegistry: makeParentRegistry([]),
    modelName: 'gpt-4o',
  });

  await tool.execute(
    {
      description: 'test',
      prompt: 'do something',
      subagent_type: 'general-purpose',
    },
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(executor.calls[0]?.options?.model, 'gpt-4o');
});

test('SubagentTool uses own system prompt in promptHistory', async () => {
  const executor = makeFakeExecutor();
  const tool = createSubagentTool({
    turnExecutor: executor,
    parentToolRegistry: makeParentRegistry([]),
    modelName: 'gpt-4o',
  });

  await tool.execute(
    {
      description: 'test',
      prompt: 'my task',
      subagent_type: 'general-purpose',
    },
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  const submission = executor.calls[0]?.submission;
  assert.ok(submission);
  const ph = submission.promptHistory;
  assert.ok(ph);
  assert.equal(ph[0]?.role, 'system');
  assert.ok(ph[0]?.content?.includes('general-purpose'));
  assert.equal(ph[1]?.role, 'user');
  assert.equal(ph[1]?.content, 'my task');
});

test('SubagentTool catches executor errors and returns failure', async () => {
  const executor = {
    async *run(): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      throw new Error('model_failed');
    },
  };

  const tool = createSubagentTool({
    turnExecutor: executor,
    parentToolRegistry: makeParentRegistry([]),
    modelName: 'gpt-4o',
  });

  const result = await tool.execute(
    {
      description: 'test',
      prompt: 'do something',
      subagent_type: 'general-purpose',
    },
    { conversationId: 'conv-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(result.success, false);
  assert.ok(result.renderForModel().includes('model_failed'));
});

// --- Sidechain recording tests ---

function makeFakeRecorder() {
  const chains: { conversationId: string; messages: Message[]; isSidechain?: boolean; agentId?: string }[] = [];
  const metadata: AgentMetadata[] = [];
  const recorder: ITranscriptRecorder = {
    async recordMessage() {},
    async recordLifecycleEvent() {},
    async insertMessageChain(conversationId, messages, isSidechain, agentId) {
      chains.push({ conversationId, messages, isSidechain, agentId });
    },
    async writeAgentMetadata(_convId, meta) {
      metadata.push(meta);
    },
    async loadTranscript() { return { messages: [], leafId: null }; },
    seedParentId() {},
  };
  return { recorder, chains, metadata };
}

function makeExecutorWithMessages(finalText: string, newMessages: Message[]) {
  return {
    async *run(): AsyncGenerator<AgentEvent, TurnExecutionResult> {
      yield { type: 'done' as const };
      return {
        finalText,
        completedTurns: 1,
        toolCallCount: 0,
        newMessages,
      };
    },
  };
}

test('SubagentTool records sidechain transcript via recorder', async () => {
  const messages: Message[] = [
    { role: 'user', content: 'task prompt', id: generateId() },
    { role: 'assistant', content: 'task result', id: generateId() },
  ];
  const { recorder, chains, metadata } = makeFakeRecorder();

  const tool = createSubagentTool({
    turnExecutor: makeExecutorWithMessages('task result', messages),
    parentToolRegistry: makeParentRegistry([]),
    modelName: 'gpt-4o',
    transcriptRecorder: recorder,
  });

  const result = await tool.execute(
    {
      description: 'test recording',
      prompt: 'do something',
      subagent_type: 'general-purpose',
    },
    { conversationId: 'conv-rec-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(result.success, true);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].isSidechain, true);
  assert.ok(chains[0].agentId?.startsWith('subagent-general-purpose-'));
  assert.equal(chains[0].messages.length, 2);

  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].agentType, 'general-purpose');
  assert.equal(metadata[0].description, 'test recording');
});

test('SubagentTool succeeds even when recorder throws', async () => {
  const messages: Message[] = [
    { role: 'assistant', content: 'good result', id: generateId() },
  ];
  const throwingRecorder: ITranscriptRecorder = {
    async recordMessage() {},
    async recordLifecycleEvent() {},
    async insertMessageChain() { throw new Error('recorder_broke'); },
    async writeAgentMetadata() { throw new Error('recorder_broke'); },
    async loadTranscript() { return { messages: [], leafId: null }; },
    seedParentId() {},
  };

  const tool = createSubagentTool({
    turnExecutor: makeExecutorWithMessages('good result', messages),
    parentToolRegistry: makeParentRegistry([]),
    modelName: 'gpt-4o',
    transcriptRecorder: throwingRecorder,
  });

  const result = await tool.execute(
    {
      description: 'test',
      prompt: 'do something',
      subagent_type: 'general-purpose',
    },
    { conversationId: 'conv-throw-1', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(result.success, true);
  assert.equal(result.renderForModel(), 'good result');
});

test('SubagentTool succeeds when no recorder is provided', async () => {
  const messages: Message[] = [
    { role: 'assistant', content: 'no recorder result', id: generateId() },
  ];

  const tool = createSubagentTool({
    turnExecutor: makeExecutorWithMessages('no recorder result', messages),
    parentToolRegistry: makeParentRegistry([]),
    modelName: 'gpt-4o',
    // no transcriptRecorder
  });

  const result = await tool.execute(
    {
      description: 'test',
      prompt: 'do something',
      subagent_type: 'general-purpose',
    },
    { conversationId: 'conv-no-rec', signal: AbortSignal.abort(), policyConfig: {} },
  );

  assert.equal(result.success, true);
  assert.equal(result.renderForModel(), 'no recorder result');
});
