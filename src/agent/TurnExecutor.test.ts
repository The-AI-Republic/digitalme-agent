import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnExecutor } from './TurnExecutor.js';
import type { CompletionRequest, ModelStepResult, ModelClient } from '../models/ModelClient.js';
import type { AgentEvent, TurnSubmission, TurnExecutionResult, ExecutionOptions } from './types.js';
import { consumeGenerator } from './types.js';
import type { ToolExecutionResult, Tool, ToolDefinition, ToolMetadata } from '../tools/types.js';
import type { ISystemPromptBuilder, BuiltPrompt, PromptContext } from '../prompts/types.js';
import { testConfig as config } from '../test/fixtures.js';
import { z } from 'zod';

class FakeModelClient implements ModelClient {
  public readonly requests: CompletionRequest[] = [];

  constructor(private readonly steps: ModelStepResult[]) {}

  async generate(request: CompletionRequest): Promise<ModelStepResult> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) {
      throw new Error('No more steps');
    }
    return step;
  }
}

class FakeTool implements Tool {
  readonly name = 'test_tool';
  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'test_tool',
      description: 'A fake tool.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
    },
  };
  readonly metadata: ToolMetadata = {
    timeoutMs: 10_000,
    maxResultChars: 20_000,
    policyCategory: 'search',
  };
  readonly inputSchema = z.object({
    query: z.string().optional(),
  });

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const content = `tool-result:${String(args.query ?? '')}`;
    return {
      success: true,
      data: { query: args.query },
      renderForModel: () => content,
    };
  }
}

function makeFakeBuilder(): ISystemPromptBuilder & { lastContext: PromptContext | null } {
  return {
    lastContext: null,
    build(context: PromptContext): BuiltPrompt {
      this.lastContext = context;
      const content = 'test-system';
      return {
        sections: [{ name: 'test', content, cachePolicy: 'stable', boundary: 'static' }],
        staticPrefix: [content],
        dynamicTail: [],
        finalSystemPrompt: [content],
      };
    },
    clearCache() {},
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent, TurnExecutionResult>): Promise<{
  events: AgentEvent[];
  result: TurnExecutionResult;
}> {
  const events: AgentEvent[] = [];
  const result = await consumeGenerator(gen, (event) => events.push(event));
  return { events, result };
}

function makeFakeTool() {
  return new FakeTool();
}

function makeToolRegistry(tool: Tool) {
  return {
    listDefinitions() {
      return [tool.definition];
    },
    listNames() {
      return [tool.name];
    },
    get(name: string) {
      return name === tool.name ? tool : undefined;
    },
  };
}

function makeExecutor(steps: ModelStepResult[]) {
  const tool = makeFakeTool();
  const client = new FakeModelClient([...steps]);
  return new TurnExecutor(config, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: {
      createClient() {
        return client;
      },
    },
    toolRegistry: makeToolRegistry(tool),
  });
}

function makeExecutorWithClient(steps: ModelStepResult[]) {
  const tool = makeFakeTool();
  const client = new FakeModelClient([...steps]);
  const executor = new TurnExecutor(config, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: {
      createClient() {
        return client;
      },
    },
    toolRegistry: makeToolRegistry(tool),
  });
  return { executor, client };
}

test('TurnExecutor ends the loop when the model returns final assistant text', async () => {
  const executor = makeExecutor([
    {
      type: 'final_text',
      text: 'final answer',
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  ]);

  const submission: TurnSubmission = {
    requestId: 'req-1',
    conversationId: 'conv-1',
    userMessage: 'hello',
    history: [],
  };

  const { events } = await collectEvents(executor.run(submission));

  assert.deepEqual(events, [
    { type: 'text_delta', content: 'final answer' },
    { type: 'done', truncated: undefined, tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ]);
});

test('TurnExecutor continues after a tool call and ends on the next final text step', async () => {
  const executor = makeExecutor([
    {
      type: 'tool_calls',
      calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: JSON.stringify({ query: 'value' }),
          },
        },
      ],
    },
    {
      type: 'final_text',
      text: 'tool-informed answer',
    },
  ]);

  const submission: TurnSubmission = {
    requestId: 'req-2',
    conversationId: 'conv-2',
    userMessage: 'use a tool',
    history: [],
  };

  const { events } = await collectEvents(executor.run(submission));

  assert.deepEqual(events, [
    { type: 'tool_start', name: 'test_tool', callId: 'call-1' },
    { type: 'tool_end', name: 'test_tool', callId: 'call-1', success: true },
    { type: 'text_delta', content: 'tool-informed answer' },
    { type: 'done', truncated: undefined, tokenUsage: undefined },
  ]);
});

test('TurnExecutor keeps grouped tool calls in one assistant message for the next model step', async () => {
  const { executor, client } = makeExecutorWithClient([
    {
      type: 'tool_calls',
      calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: JSON.stringify({ query: 'first' }),
          },
        },
        {
          id: 'call-2',
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: JSON.stringify({ query: 'second' }),
          },
        },
      ],
    },
    {
      type: 'final_text',
      text: 'done',
    },
  ]);

  const submission: TurnSubmission = {
    requestId: 'req-3',
    conversationId: 'conv-3',
    userMessage: 'use two tools',
    history: [],
  };

  await collectEvents(executor.run(submission));

  assert.equal(client.requests.length, 2);
  assert.deepEqual(client.requests[1]?.messages.slice(-3), [
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: JSON.stringify({ query: 'first' }),
          },
        },
        {
          id: 'call-2',
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: JSON.stringify({ query: 'second' }),
          },
        },
      ],
    },
    {
      role: 'tool',
      content: 'tool-result:first',
      toolCallId: 'call-1',
      toolName: 'test_tool',
    },
    {
      role: 'tool',
      content: 'tool-result:second',
      toolCallId: 'call-2',
      toolName: 'test_tool',
    },
  ]);
});

test('TurnExecutor aborts before starting model work when the request is already canceled', async () => {
  const { executor, client } = makeExecutorWithClient([
    {
      type: 'final_text',
      text: 'should not run',
    },
  ]);

  const controller = new AbortController();
  controller.abort();

  const submission: TurnSubmission = {
    requestId: 'req-4',
    conversationId: 'conv-4',
    userMessage: 'hello',
    history: [],
    signal: controller.signal,
  };

  await assert.rejects(() => collectEvents(executor.run(submission)), /request_aborted/);
  assert.equal(client.requests.length, 0);
});

test('TurnExecutor exposes committed prompt messages for session reuse', async () => {
  const executor = makeExecutor([
    {
      type: 'tool_calls',
      calls: [
        {
          id: 'call-9',
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: JSON.stringify({ query: 'carry-forward' }),
          },
        },
      ],
    },
    {
      type: 'final_text',
      text: 'final answer',
    },
  ]);

  const submission: TurnSubmission = {
    requestId: 'req-9',
    conversationId: 'conv-9',
    userMessage: 'remember this',
    history: [],
  };

  const { result } = await collectEvents(executor.run(submission));
  assert.deepEqual(result.promptMessages, [
    { role: 'user', content: 'remember this' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        {
          id: 'call-9',
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: JSON.stringify({ query: 'carry-forward' }),
          },
        },
      ],
    },
    {
      role: 'tool',
      content: 'tool-result:carry-forward',
      toolCallId: 'call-9',
      toolName: 'test_tool',
    },
    { role: 'assistant', content: 'final answer' },
  ]);
});

test('TurnExecutor passes correct PromptContext fields to builder', async () => {
  const builder = makeFakeBuilder();
  const tool = makeFakeTool();
  const client = new FakeModelClient([
    { type: 'final_text', text: 'ok' },
  ]);

  const executor = new TurnExecutor(config, {
    systemPromptBuilder: builder,
    modelClientFactory: { createClient() { return client; } },
    toolRegistry: makeToolRegistry(tool),
  });

  await collectEvents(executor.run(
    { requestId: 'req-ctx', conversationId: 'conv-ctx', userMessage: 'hi', history: [] },
  ));

  assert.ok(builder.lastContext);
  assert.equal(builder.lastContext.soulName, 'Test Agent');
  assert.equal(builder.lastContext.soulDescription, 'You are a test agent.');
  assert.deepEqual(builder.lastContext.approvedToolNames, ['test_tool']);
  assert.equal(builder.lastContext.modelName, 'gpt-4o');
  assert.equal(builder.lastContext.providerName, 'openai');
});

// --- ExecutionOptions tests ---

test('ExecutionOptions.maxTurns overrides config default', async () => {
  const executor = makeExecutor([
    {
      type: 'tool_calls',
      calls: [{
        id: 'call-1', type: 'function',
        function: { name: 'test_tool', arguments: '{}' },
      }],
    },
    {
      type: 'tool_calls',
      calls: [{
        id: 'call-2', type: 'function',
        function: { name: 'test_tool', arguments: '{}' },
      }],
    },
    { type: 'final_text', text: 'should not reach' },
  ]);

  const submission: TurnSubmission = {
    requestId: 'req-mt', conversationId: 'conv-mt', userMessage: 'hi', history: [],
  };

  await assert.rejects(
    () => collectEvents(executor.run(submission, { maxTurns: 1 })),
    /max_turns_exceeded/,
  );
});

test('ExecutionOptions.toolRegistry overrides default registry', async () => {
  const builder = makeFakeBuilder();
  const defaultTool = makeFakeTool();
  const client = new FakeModelClient([
    { type: 'final_text', text: 'ok' },
  ]);

  const executor = new TurnExecutor(config, {
    systemPromptBuilder: builder,
    modelClientFactory: { createClient() { return client; } },
    toolRegistry: makeToolRegistry(defaultTool),
  });

  const emptyRegistry = {
    listDefinitions() { return []; },
    listNames() { return []; },
    get() { return undefined; },
  };

  await collectEvents(executor.run(
    { requestId: 'req-tr', conversationId: 'conv-tr', userMessage: 'hi', history: [] },
    { toolRegistry: emptyRegistry },
  ));

  assert.ok(builder.lastContext);
  assert.deepEqual(builder.lastContext.approvedToolNames, []);
  assert.deepEqual(client.requests[0]?.tools, []);
});

test('ExecutionOptions.maxOutputTokens overrides config default', async () => {
  const { executor, client } = makeExecutorWithClient([
    { type: 'final_text', text: 'ok' },
  ]);

  await collectEvents(executor.run(
    { requestId: 'req-mo', conversationId: 'conv-mo', userMessage: 'hi', history: [] },
    { maxOutputTokens: 256 },
  ));

  assert.equal(client.requests[0]?.maxOutputTokens, 256);
});

test('ExecutionOptions.model overrides config default', async () => {
  const { executor, client } = makeExecutorWithClient([
    { type: 'final_text', text: 'ok' },
  ]);

  await collectEvents(executor.run(
    { requestId: 'req-mdl', conversationId: 'conv-mdl', userMessage: 'hi', history: [] },
    { model: 'gpt-4o-mini' },
  ));

  assert.equal(client.requests[0]?.model, 'gpt-4o-mini');
});

test('No ExecutionOptions uses config defaults', async () => {
  const { executor, client } = makeExecutorWithClient([
    { type: 'final_text', text: 'ok' },
  ]);

  await collectEvents(executor.run(
    { requestId: 'req-def', conversationId: 'conv-def', userMessage: 'hi', history: [] },
  ));

  assert.equal(client.requests[0]?.model, 'gpt-4o');
  assert.equal(client.requests[0]?.maxOutputTokens, 8192);
});

test('TurnExecutor yields tool_start before tool_end for each tool call', async () => {
  const executor = makeExecutor([
    {
      type: 'tool_calls',
      calls: [
        {
          id: 'call-a',
          type: 'function',
          function: { name: 'test_tool', arguments: '{}' },
        },
        {
          id: 'call-b',
          type: 'function',
          function: { name: 'test_tool', arguments: '{}' },
        },
      ],
    },
    { type: 'final_text', text: 'done' },
  ]);

  const submission: TurnSubmission = {
    requestId: 'req-timing',
    conversationId: 'conv-timing',
    userMessage: 'time test',
    history: [],
  };

  const { events } = await collectEvents(executor.run(submission));
  const toolEvents = events.filter(e => e.type === 'tool_start' || e.type === 'tool_end');

  // tool_start for call-a must come before tool_end for call-a
  const startA = toolEvents.findIndex(e => e.type === 'tool_start' && 'callId' in e && e.callId === 'call-a');
  const endA = toolEvents.findIndex(e => e.type === 'tool_end' && 'callId' in e && e.callId === 'call-a');
  assert.ok(startA < endA, 'tool_start should come before tool_end for call-a');

  // tool_start for call-b must come before tool_end for call-b
  const startB = toolEvents.findIndex(e => e.type === 'tool_start' && 'callId' in e && e.callId === 'call-b');
  const endB = toolEvents.findIndex(e => e.type === 'tool_end' && 'callId' in e && e.callId === 'call-b');
  assert.ok(startB < endB, 'tool_start should come before tool_end for call-b');
});

// --- consumeGenerator tests ---

test('consumeGenerator forwards events and returns the result', async () => {
  async function* gen(): AsyncGenerator<string, number> {
    yield 'a';
    yield 'b';
    return 42;
  }

  const collected: string[] = [];
  const result = await consumeGenerator(gen(), (event) => collected.push(event));

  assert.deepEqual(collected, ['a', 'b']);
  assert.equal(result, 42);
});

test('consumeGenerator returns immediately for empty generator', async () => {
  async function* gen(): AsyncGenerator<string, number> {
    return 0;
  }

  const collected: string[] = [];
  const result = await consumeGenerator(gen(), (event) => collected.push(event));

  assert.deepEqual(collected, []);
  assert.equal(result, 0);
});
