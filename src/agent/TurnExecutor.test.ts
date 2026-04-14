import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnExecutor } from './TurnExecutor.js';
import type { CompletionRequest, ModelStepResult, ModelClient } from '../models/ModelClient.js';
import { ModelRouter } from '../models/ModelRouter.js';
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

function makeTestFactory(client: FakeModelClient) {
  return {
    createClient() { return client; },
    createFromConfig() { return client; },
  };
}

function makeExecutor(steps: ModelStepResult[]) {
  const tool = makeFakeTool();
  const client = new FakeModelClient([...steps]);
  return new TurnExecutor(config, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: makeTestFactory(client),
    toolRegistry: makeToolRegistry(tool),
  });
}

function makeExecutorWithClient(steps: ModelStepResult[]) {
  const tool = makeFakeTool();
  const client = new FakeModelClient([...steps]);
  const executor = new TurnExecutor(config, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: makeTestFactory(client),
    toolRegistry: makeToolRegistry(tool),
  });
  return { executor, client };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('TurnExecutor yields tool_start before the tool finishes', async () => {
  const toolResult = deferred<ToolExecutionResult>();
  const slowTool = new class extends FakeTool {
    override async execute(): Promise<ToolExecutionResult> {
      return toolResult.promise;
    }
  }();
  const client = new FakeModelClient([
    {
      type: 'tool_calls',
      calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: '{}',
          },
        },
      ],
    },
    {
      type: 'final_text',
      text: 'done',
    },
  ]);
  const executor = new TurnExecutor(config, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: makeTestFactory(client),
    toolRegistry: makeToolRegistry(slowTool),
  });

  const gen = executor.run({
    requestId: 'req-stream-tool',
    conversationId: 'conv-stream-tool',
    userMessage: 'use a slow tool',
    history: [],
  });

  assert.deepEqual(await gen.next(), {
    done: false,
    value: { type: 'tool_start', name: 'test_tool', callId: 'call-1' },
  });

  toolResult.resolve({
    success: true,
    data: {},
    renderForModel: () => 'slow-result',
  });

  assert.deepEqual(await gen.next(), {
    done: false,
    value: { type: 'tool_end', name: 'test_tool', callId: 'call-1', success: true },
  });
  assert.deepEqual(await gen.next(), {
    done: false,
    value: { type: 'text_delta', content: 'done' },
  });
  const doneStep = await gen.next();
  assert.equal(doneStep.done, false);
  assert.equal((doneStep.value as AgentEvent).type, 'done');
  assert.equal((await gen.next()).done, true);
});

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

  // Filter out usage events (tested separately in usage module tests)
  const coreEvents = events.filter(e => e.type !== 'usage');
  assert.deepEqual(coreEvents, [
    { type: 'text_delta', content: 'final answer' },
    { type: 'done', truncated: undefined, tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, terminalReason: { reason: 'completed' } },
  ]);

  // Verify a usage event was emitted
  const usageEvents = events.filter(e => e.type === 'usage');
  assert.equal(usageEvents.length, 1);
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

  // Filter out usage events (tested separately in usage module tests)
  const coreEvents = events.filter(e => e.type !== 'usage');
  assert.deepEqual(coreEvents, [
    { type: 'tool_start', name: 'test_tool', callId: 'call-1' },
    { type: 'tool_end', name: 'test_tool', callId: 'call-1', success: true },
    { type: 'text_delta', content: 'tool-informed answer' },
    { type: 'done', truncated: undefined, tokenUsage: undefined, terminalReason: { reason: 'completed' } },
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
  // Note: client.requests[1].messages is a live reference to context.messages,
  // which now includes the final assistant msg pushed after the second generate() call.
  // The second request saw: [system, user, assistant(toolCalls), tool1, tool2]
  // After final_text, the final assistant message was also pushed, so the array is now 6 items.
  const msgs = client.requests[1]?.messages;
  assert.ok(msgs);
  // Find the assistant message with toolCalls (index 2: system=0, user=1, assistant=2)
  const assistantIdx = msgs.findIndex((m: { role: string; toolCalls?: unknown[] }) => m.role === 'assistant' && m.toolCalls);
  assert.ok(assistantIdx >= 0, 'should find assistant with toolCalls');
  const assistantMsg = msgs[assistantIdx];
  assert.equal(assistantMsg.content, null);
  assert.deepEqual(assistantMsg.toolCalls, [
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
  ]);
  // Tool result messages follow the assistant
  const tool1 = msgs[assistantIdx + 1];
  const tool2 = msgs[assistantIdx + 2];
  assert.equal(tool1.role, 'tool');
  assert.equal(tool1.content, 'tool-result:first');
  assert.equal(tool1.toolCallId, 'call-1');
  assert.equal(tool1.toolName, 'test_tool');
  assert.equal(tool2.role, 'tool');
  assert.equal(tool2.content, 'tool-result:second');
  assert.equal(tool2.toolCallId, 'call-2');
  assert.equal(tool2.toolName, 'test_tool');
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

  const { events } = await collectEvents(executor.run(submission));
  const doneEvent = events.find(e => e.type === 'done') as { terminalReason?: { reason: string } } | undefined;
  assert.ok(doneEvent, 'done event must be emitted for pre-aborted signal');
  assert.equal(doneEvent?.terminalReason?.reason, 'aborted');
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
  const msgs = result.newMessages;
  assert.equal(msgs.length, 4);
  // user message
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, 'remember this');
  // assistant tool call
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, null);
  assert.deepEqual(msgs[1].toolCalls, [
    {
      id: 'call-9',
      type: 'function',
      function: {
        name: 'test_tool',
        arguments: JSON.stringify({ query: 'carry-forward' }),
      },
    },
  ]);
  // tool result
  assert.equal(msgs[2].role, 'tool');
  assert.equal(msgs[2].content, 'tool-result:carry-forward');
  assert.equal(msgs[2].toolCallId, 'call-9');
  assert.equal(msgs[2].toolName, 'test_tool');
  // final assistant text
  assert.equal(msgs[3].role, 'assistant');
  assert.equal(msgs[3].content, 'final answer');
});

test('TurnExecutor passes correct PromptContext fields to builder', async () => {
  const builder = makeFakeBuilder();
  const tool = makeFakeTool();
  const client = new FakeModelClient([
    { type: 'final_text', text: 'ok' },
  ]);

  const executor = new TurnExecutor(config, {
    systemPromptBuilder: builder,
    modelClientFactory: makeTestFactory(client),
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

test('ExecutionOptions.maxTurns overrides config default and returns gracefully', async () => {
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

  const { events, result } = await collectEvents(executor.run(submission, { maxTurns: 1 }));

  // max_turns now returns gracefully instead of throwing
  const doneEvent = events.find(e => e.type === 'done');
  assert.ok(doneEvent);
  assert.equal((doneEvent as { terminalReason?: { reason: string } }).terminalReason?.reason, 'max_turns');
  assert.equal(result.completedTurns, 1);
});

test('ExecutionOptions.toolRegistry overrides default registry', async () => {
  const builder = makeFakeBuilder();
  const defaultTool = makeFakeTool();
  const client = new FakeModelClient([
    { type: 'final_text', text: 'ok' },
  ]);

  const executor = new TurnExecutor(config, {
    systemPromptBuilder: builder,
    modelClientFactory: makeTestFactory(client),
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

test('ExecutionOptions.model bypasses router resolution when a router is injected', async () => {
  const client = new FakeModelClient([
    { type: 'final_text', text: 'ok' },
  ]);
  const router = new ModelRouter({
    ...config,
    routing: {
      ...config.routing,
      task_models: {
        ...config.routing.task_models,
        summary: {
          provider: 'openai',
          name: 'gpt-4o-mini',
          api_key: 'summary-key',
          base_url: null,
          max_output_tokens: 4096,
        },
      },
    },
  }, {
    createClient() {
      return client;
    },
    createFromConfig() {
      return client;
    },
  });

  const executor = new TurnExecutor(config, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: {
      createClient() { return client; },
      createFromConfig() { return client; },
      getRouter() { return router; },
    },
    modelRouter: router,
    toolRegistry: makeToolRegistry(makeFakeTool()),
  });

  await collectEvents(executor.run(
    { requestId: 'req-mdl-router', conversationId: 'conv-mdl-router', userMessage: 'hi', history: [] },
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
