import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnExecutor } from './TurnExecutor.js';
import type { CompletionRequest, ModelStepResult, ModelClient } from '../models/ModelClient.js';
import { EventQueue } from './EventQueue.js';
import type { AgentEvent, TurnSubmission } from './types.js';
import type { Message } from '../models/ModelClient.js';
import type { ToolExecutionResult, Tool, ToolDefinition } from '../tools/types.js';
import { testConfig as config } from '../test/fixtures.js';

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

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return {
      success: true,
      content: `tool-result:${String(args.query ?? '')}`,
    };
  }
}

async function collectEvents(queue: EventQueue<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of queue) {
    events.push(event);
  }
  return events;
}

function makeExecutor(steps: ModelStepResult[]) {
  const tool = new FakeTool();
  const client = new FakeModelClient([...steps]);
  return new TurnExecutor(config, {
    promptComposer: {
      compose(history: Message[], latestUserMessage: string) {
        return [
          { role: 'system', content: 'test-system' },
          ...history,
          { role: 'user', content: latestUserMessage },
        ];
      },
    },
    modelClientFactory: {
      createClient() {
        return client;
      },
    },
    toolRegistry: {
      listDefinitions() {
        return [tool.definition];
      },
      listNames() {
        return [tool.name];
      },
      get(name: string) {
        return name === tool.name ? tool : undefined;
      },
    },
  });
}

function makeExecutorWithClient(steps: ModelStepResult[]) {
  const tool = new FakeTool();
  const client = new FakeModelClient([...steps]);
  const executor = new TurnExecutor(config, {
    promptComposer: {
      compose(history: Message[], latestUserMessage: string) {
        return [
          { role: 'system', content: 'test-system' },
          ...history,
          { role: 'user', content: latestUserMessage },
        ];
      },
    },
    modelClientFactory: {
      createClient() {
        return client;
      },
    },
    toolRegistry: {
      listDefinitions() {
        return [tool.definition];
      },
      listNames() {
        return [tool.name];
      },
      get(name: string) {
        return name === tool.name ? tool : undefined;
      },
    },
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

  const events = new EventQueue<AgentEvent>();
  const submission: TurnSubmission = {
    requestId: 'req-1',
    conversationId: 'conv-1',
    userMessage: 'hello',
    history: [],
  };

  const execution = executor.execute(submission, events).finally(() => events.close());
  const collected = await collectEvents(events);
  await execution;

  assert.deepEqual(collected, [
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

  const events = new EventQueue<AgentEvent>();
  const submission: TurnSubmission = {
    requestId: 'req-2',
    conversationId: 'conv-2',
    userMessage: 'use a tool',
    history: [],
  };

  const execution = executor.execute(submission, events).finally(() => events.close());
  const collected = await collectEvents(events);
  await execution;

  assert.deepEqual(collected, [
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

  const events = new EventQueue<AgentEvent>();
  const submission: TurnSubmission = {
    requestId: 'req-3',
    conversationId: 'conv-3',
    userMessage: 'use two tools',
    history: [],
  };

  await executor.execute(submission, events);

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

  const events = new EventQueue<AgentEvent>();
  const submission: TurnSubmission = {
    requestId: 'req-4',
    conversationId: 'conv-4',
    userMessage: 'hello',
    history: [],
    signal: controller.signal,
  };

  await assert.rejects(() => executor.execute(submission, events), /request_aborted/);
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

  const events = new EventQueue<AgentEvent>();
  const submission: TurnSubmission = {
    requestId: 'req-9',
    conversationId: 'conv-9',
    userMessage: 'remember this',
    history: [],
  };

  const result = await executor.run(submission, events);
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
