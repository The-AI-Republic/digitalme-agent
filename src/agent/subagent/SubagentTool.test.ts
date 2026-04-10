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
          async execute() { return { success: true, content: 'ok' }; },
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
    { conversationId: 'conv-1' },
  );

  assert.equal(result.success, true);
  assert.equal(result.content, 'hello from subagent');
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
    { conversationId: 'conv-1' },
  );

  assert.equal(result.success, false);
  assert.ok(result.content.includes('Unknown agent type'));
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
    { conversationId: 'conv-1' },
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
    { conversationId: 'conv-1' },
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
    { conversationId: 'conv-1' },
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
    { conversationId: 'conv-1' },
  );

  assert.equal(result.success, false);
  assert.ok(result.content.includes('model_failed'));
});
