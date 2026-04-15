import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnExecutor } from './TurnExecutor.js';
import type { CompletionRequest, ModelStepResult, ModelClient } from '../models/ModelClient.js';
import type { AgentEvent, TurnSubmission, TurnExecutionResult } from './types.js';
import { consumeGenerator } from './types.js';
import type { ToolExecutionResult, Tool, ToolDefinition, ToolMetadata } from '../tools/types.js';
import type { ISystemPromptBuilder, BuiltPrompt, PromptContext } from '../prompts/types.js';
import { z } from 'zod';
import type { IModelClientFactory } from '../models/ModelClientFactory.js';
import type { ModelConfig } from '../config/schema.js';
import { testConfig } from '../test/fixtures.js';

// --- Test helpers ---

type StepOrError = ModelStepResult | { error: unknown };

class FakeModelClient implements ModelClient {
  public readonly requests: CompletionRequest[] = [];
  private readonly steps: StepOrError[];

  constructor(steps: StepOrError[]) {
    this.steps = [...steps];
  }

  async generate(request: CompletionRequest): Promise<ModelStepResult> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) throw new Error('No more steps');
    if ('error' in step) throw step.error;
    return step;
  }
}

function makeFakeBuilder(): ISystemPromptBuilder {
  return {
    build(_context: PromptContext): BuiltPrompt {
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

function makeFakeTool(): Tool {
  return {
    name: 'test_tool',
    definition: {
      type: 'function',
      function: { name: 'test_tool', description: 'fake', parameters: { type: 'object', properties: {} } },
    },
    metadata: {
      timeoutMs: 10_000,
      maxResultChars: 20_000,
      policyCategory: 'search',
    } satisfies ToolMetadata,
    inputSchema: z.object({}),
    async execute(): Promise<ToolExecutionResult> {
      return { success: true, data: {}, renderForModel: () => 'tool-result' };
    },
  };
}

function makeToolRegistry(tool: Tool) {
  return {
    listDefinitions() { return [tool.definition]; },
    listNames() { return [tool.name]; },
    get(name: string) { return name === tool.name ? tool : undefined; },
  };
}

const submission: TurnSubmission = {
  requestId: 'req-1',
  conversationId: 'conv-1',
  userMessage: 'hello',
  history: [],
};

async function collectEvents(gen: AsyncGenerator<AgentEvent, TurnExecutionResult>): Promise<{
  events: AgentEvent[];
  result: TurnExecutionResult;
}> {
  const events: AgentEvent[] = [];
  const result = await consumeGenerator(gen, (event) => events.push(event));
  return { events, result };
}

function makeExecutor(
  primarySteps: StepOrError[],
  fallbackSteps?: StepOrError[],
  configOverrides?: Partial<typeof testConfig>,
) {
  const tool = makeFakeTool();
  const primaryClient = new FakeModelClient(primarySteps);
  const fallbackClient = fallbackSteps ? new FakeModelClient(fallbackSteps) : undefined;
  const config = { ...testConfig, ...configOverrides };

  const factory: IModelClientFactory = {
    createClient() { return primaryClient; },
    createFromConfig(modelConfig: ModelConfig) {
      const fallbackModel = config.fallback_model;
      if (
        fallbackClient
        && fallbackModel
        && modelConfig.provider === fallbackModel.provider
        && modelConfig.name === fallbackModel.name
        && modelConfig.api_key === fallbackModel.api_key
        && modelConfig.base_url === fallbackModel.base_url
      ) {
        return fallbackClient;
      }
      if (
        modelConfig.provider === config.model.provider
        && modelConfig.name === config.model.name
        && modelConfig.api_key === config.model.api_key
        && modelConfig.base_url === config.model.base_url
      ) {
        return primaryClient;
      }
      throw new Error(`Unexpected model config in test factory: ${modelConfig.provider}/${modelConfig.name}`);
    },
  };

  const executor = new TurnExecutor(config, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: factory,
    toolRegistry: makeToolRegistry(tool),
  });

  return { executor, primaryClient, fallbackClient };
}

// --- API Retry Tests ---

test('recovery: 429 twice then success -> retries and completes', async () => {
  const { executor } = makeExecutor([
    { error: { status: 429, message: 'Rate limited' } },
    { error: { status: 429, message: 'Rate limited' } },
    { type: 'final_text', text: 'success after retry' },
  ]);

  const { events, result } = await collectEvents(executor.run(submission));

  const recoveryEvents = events.filter(e => e.type === 'recovery');
  assert.equal(recoveryEvents.length, 2);
  assert.equal((recoveryEvents[0] as { reason: string }).reason, 'api_retry');
  assert.equal((recoveryEvents[1] as { reason: string }).reason, 'api_retry');
  assert.equal(result.finalText, 'success after retry');
});

test('recovery: 5xx then success -> retries and completes', async () => {
  const { executor } = makeExecutor([
    { error: { status: 500, message: 'Internal Server Error' } },
    { type: 'final_text', text: 'recovered' },
  ]);

  const { events, result } = await collectEvents(executor.run(submission));

  const recoveryEvents = events.filter(e => e.type === 'recovery');
  assert.equal(recoveryEvents.length, 1);
  assert.equal(result.finalText, 'recovered');
});

test('recovery: 413 -> returns context_overflow and triggers compaction', async () => {
  // Build a transcript long enough to compact: system + 4 rounds
  const longHistory = [
    { role: 'user' as const, content: 'q1' }, { role: 'assistant' as const, content: 'a1' },
    { role: 'user' as const, content: 'q2' }, { role: 'assistant' as const, content: 'a2' },
    { role: 'user' as const, content: 'q3' }, { role: 'assistant' as const, content: 'a3' },
  ];
  const { executor } = makeExecutor([
    { error: { status: 413, message: 'Payload Too Large' } },
    { type: 'final_text', text: 'after compaction' },
  ]);

  const sub: TurnSubmission = { ...submission, history: longHistory };
  const { events, result } = await collectEvents(executor.run(sub));

  const recoveryEvents = events.filter(e => e.type === 'recovery');
  assert.ok(recoveryEvents.some(e => (e as { reason: string }).reason === 'reactive_compact_retry'));
  assert.equal(result.finalText, 'after compaction');
});

test('recovery: 413 when transcript too short to compact -> prompt_too_long', async () => {
  const { executor } = makeExecutor([
    { error: { status: 413, message: 'Payload Too Large' } },
  ]);

  const { events, result } = await collectEvents(executor.run(submission));

  const doneEvent = events.find(e => e.type === 'done') as { terminalReason?: { reason: string } };
  assert.equal(doneEvent?.terminalReason?.reason, 'prompt_too_long');
  assert.equal(result.finalText, '');
});

test('recovery: 401 -> terminates with model_error without retry', async () => {
  const { executor } = makeExecutor([
    { error: { status: 401, message: 'Unauthorized' } },
  ]);

  const { events, result } = await collectEvents(executor.run(submission));

  const doneEvent = events.find(e => e.type === 'done') as { terminalReason?: { reason: string; error?: string } };
  assert.equal(doneEvent?.terminalReason?.reason, 'model_error');
  assert.ok(doneEvent?.terminalReason?.error);
  assert.equal(result.finalText, '');
});

test('recovery: retries exhaust after MAX_API_RETRIES -> model_error', async () => {
  const { executor } = makeExecutor([
    { error: { status: 500, message: 'fail' } },
    { error: { status: 500, message: 'fail' } },
    { error: { status: 500, message: 'fail' } },
    { error: { status: 500, message: 'fail' } },  // 4th = exhausted
  ]);

  const { events, result } = await collectEvents(executor.run(submission));

  const doneEvent = events.find(e => e.type === 'done') as { terminalReason?: { reason: string; error?: string } };
  assert.equal(doneEvent?.terminalReason?.reason, 'model_error');
  assert.ok(doneEvent?.terminalReason?.error);
  assert.equal(result.finalText, '');
});

test('recovery: recovery events are emitted even when retries exhaust', async () => {
  const { executor } = makeExecutor([
    { error: { status: 500, message: 'fail' } },
    { error: { status: 500, message: 'fail' } },
    { error: { status: 500, message: 'fail' } },
    { error: { status: 500, message: 'fail' } },
  ]);

  const events: AgentEvent[] = [];
  const gen = executor.run(submission);
  try {
    await consumeGenerator(gen, (event) => events.push(event));
  } catch {
    // expected
  }

  // Should have emitted 3 api_retry events before the final throw
  const retryEvents = events.filter(e => e.type === 'recovery' && (e as { reason: string }).reason === 'api_retry');
  assert.equal(retryEvents.length, 3, 'Expected 3 retry events before exhaustion');
});

// --- Fallback Model Tests ---

test('recovery: 529 x3 with fallback configured -> switches model', async () => {
  const fallbackConfig = {
    ...testConfig,
    fallback_model: {
      provider: 'openai' as const,
      name: 'gpt-4o-mini',
      api_key: 'fallback-key',
      base_url: null,
      context_window_size: 128000,
      max_output_tokens: 4096,
    },
  };

  const { executor } = makeExecutor(
    [
      { error: { status: 529, message: 'Overloaded' } },
      { error: { status: 529, message: 'Overloaded' } },
      { error: { status: 529, message: 'Overloaded' } },
    ],
    [{ type: 'final_text', text: 'fallback answer' }],
    fallbackConfig,
  );

  const { events, result } = await collectEvents(executor.run(submission));

  const fallbackEvent = events.find(e => e.type === 'recovery' && (e as { reason: string }).reason === 'fallback_model');
  assert.ok(fallbackEvent, 'Expected fallback_model recovery event');
  assert.equal(result.finalText, 'fallback answer');
});

test('recovery: fallback gets a fresh retry budget (full MAX_API_RETRIES attempts)', async () => {
  const fallbackConfig = {
    ...testConfig,
    fallback_model: {
      provider: 'openai' as const,
      name: 'gpt-4o-mini',
      api_key: 'fallback-key',
      base_url: null,
      context_window_size: 128000,
      max_output_tokens: 4096,
    },
  };

  // Primary fails 3x with 529, then fallback fails 3x with 500 then succeeds on 4th attempt.
  // This exercises the full retry budget (MAX_API_RETRIES=3 retries -> 4 total attempts).
  const { executor } = makeExecutor(
    [
      { error: { status: 529, message: 'Overloaded' } },
      { error: { status: 529, message: 'Overloaded' } },
      { error: { status: 529, message: 'Overloaded' } },
    ],
    [
      { error: { status: 500, message: 'Transient' } },
      { error: { status: 500, message: 'Transient' } },
      { error: { status: 500, message: 'Transient' } },
      { type: 'final_text', text: 'fallback recovered' },
    ],
    fallbackConfig,
  );

  const { result } = await collectEvents(executor.run(submission));
  assert.equal(result.finalText, 'fallback recovered');
});

test('recovery: fallback uses the fallback model name in requests', async () => {
  const fallbackConfig = {
    ...testConfig,
    fallback_model: {
      provider: 'openai' as const,
      name: 'gpt-4o-mini',
      api_key: 'fallback-key',
      base_url: null,
      context_window_size: 128000,
      max_output_tokens: 4096,
    },
  };

  const { executor, fallbackClient } = makeExecutor(
    [
      { error: { status: 529, message: 'Overloaded' } },
      { error: { status: 529, message: 'Overloaded' } },
      { error: { status: 529, message: 'Overloaded' } },
    ],
    [{ type: 'final_text', text: 'ok' }],
    fallbackConfig,
  );

  await collectEvents(executor.run(submission));

  // The fallback client should receive requests with the fallback model name, not the primary
  assert.ok(fallbackClient);
  assert.equal(fallbackClient!.requests.length, 1);
  assert.equal(fallbackClient!.requests[0]!.model, 'gpt-4o-mini');
});

// --- Max-Output Continuation Tests ---

test('recovery: truncated output -> continues and concatenates', async () => {
  const { executor } = makeExecutor([
    { type: 'final_text', text: 'part1-', truncated: true },
    { type: 'final_text', text: 'part2' },
  ]);

  const { events, result } = await collectEvents(executor.run(submission));

  assert.equal(result.finalText, 'part1-part2');
  const recoveryEvents = events.filter(e => e.type === 'recovery' && (e as { reason: string }).reason === 'max_output_recovery');
  assert.equal(recoveryEvents.length, 1);
});

test('recovery: multiple truncations accumulate correctly', async () => {
  const { executor } = makeExecutor([
    { type: 'final_text', text: 'A', truncated: true },
    { type: 'final_text', text: 'B', truncated: true },
    { type: 'final_text', text: 'C' },
  ]);

  const { result } = await collectEvents(executor.run(submission));
  assert.equal(result.finalText, 'ABC');
});

test('recovery: blocked partial output persists refusal message in newMessages', async () => {
  const config = {
    ...testConfig,
    guardrails: {
      ...testConfig.guardrails,
      enabled: true,
      blocked_keywords: ['forbidden phrase'],
      jailbreak_detection: { enabled: false },
      pii_detection: { enabled: false, block_in_input: false, block_in_output: false },
      messages: {
        input_blocked: 'Input blocked.',
        output_blocked: 'Output blocked.',
      },
    },
  };
  const { executor } = makeExecutor([
    { type: 'final_text', text: 'contains forbidden phrase', truncated: true },
  ], undefined, config);

  const { result } = await collectEvents(executor.run(submission));

  assert.equal(result.finalText, 'Output blocked.');
  const assistantMessages = result.newMessages.filter((message) => message.role === 'assistant');
  assert.ok(assistantMessages.length >= 1, 'Expected a persisted refusal assistant message');
  assert.equal(assistantMessages.at(-1)?.content, 'Output blocked.');
  assert.equal(assistantMessages.at(-1)?.synthetic, true);
});

test('recovery: truncation exhausted after MAX_OUTPUT_RECOVERY_ATTEMPTS -> max_output_exhausted', async () => {
  const { executor } = makeExecutor([
    { type: 'final_text', text: '1', truncated: true },
    { type: 'final_text', text: '2', truncated: true },
    { type: 'final_text', text: '3', truncated: true },
    { type: 'final_text', text: '4', truncated: true }, // 4th = exhausted (limit is 3 recoveries)
  ]);

  const { events, result } = await collectEvents(executor.run(submission));

  assert.equal(result.finalText, '1234');
  const doneEvent = events.find(e => e.type === 'done') as { terminalReason?: { reason: string } };
  assert.equal(doneEvent?.terminalReason?.reason, 'max_output_exhausted');
});

test('recovery: partial assistant text is preserved in context.messages for model calls', async () => {
  const { executor, primaryClient } = makeExecutor([
    { type: 'final_text', text: 'partial-', truncated: true },
    { type: 'final_text', text: 'rest' },
  ]);

  await collectEvents(executor.run(submission));

  // The second request should contain the partial assistant message
  const secondRequest = primaryClient.requests[1]!;
  const assistantMsg = secondRequest.messages.find(m => m.role === 'assistant' && m.content === 'partial-');
  assert.ok(assistantMsg, 'Partial assistant text should be in messages for second request');
  // Should also contain the continuation user message
  const contMsg = secondRequest.messages.find(m => m.role === 'user' && m.content?.includes('Resume'));
  assert.ok(contMsg, 'Continuation user message should be in messages');
});

test('recovery: newMessages includes full conversation after successful continuation', async () => {
  const { executor } = makeExecutor([
    { type: 'final_text', text: 'part1-', truncated: true },
    { type: 'final_text', text: 'part2' },
  ]);

  const { result } = await collectEvents(executor.run(submission));

  // newMessages captures the full conversation including continuation artifacts
  assert.equal(result.newMessages[0]?.content, 'hello');
  // Final assistant message should have the full concatenated text
  const lastMsg = result.newMessages[result.newMessages.length - 1]!;
  assert.equal(lastMsg.role, 'assistant');
  assert.equal(lastMsg.content, 'part1-part2');
});

test('recovery: newMessages preserves continuation messages on max_output_exhausted', async () => {
  const { executor } = makeExecutor([
    { type: 'final_text', text: '1', truncated: true },
    { type: 'final_text', text: '2', truncated: true },
    { type: 'final_text', text: '3', truncated: true },
    { type: 'final_text', text: '4', truncated: true },
  ]);

  const { result } = await collectEvents(executor.run(submission));

  // newMessages includes the original user message
  assert.equal(result.newMessages[0]?.content, 'hello');
  // Should have partial assistant messages from continuation
  const assistantMsgs = result.newMessages.filter(m => m.role === 'assistant');
  assert.ok(assistantMsgs.length >= 1, 'Should have at least one assistant message');
});

// --- Graceful max_turns ---

test('recovery: max_turns returns gracefully with terminalReason', async () => {
  const { executor } = makeExecutor([
    {
      type: 'tool_calls',
      calls: [{ id: 'c1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }],
    },
    {
      type: 'tool_calls',
      calls: [{ id: 'c2', type: 'function', function: { name: 'test_tool', arguments: '{}' } }],
    },
  ]);

  const { events, result } = await collectEvents(executor.run(submission, { maxTurns: 2 }));

  const doneEvent = events.find(e => e.type === 'done') as { terminalReason?: { reason: string } };
  assert.equal(doneEvent?.terminalReason?.reason, 'max_turns');
  assert.equal(result.completedTurns, 2);
  // Should NOT have thrown
  assert.ok(result);
});

test('recovery: max_turns preserves accumulated text', async () => {
  const { executor } = makeExecutor([
    { type: 'final_text', text: 'partial-', truncated: true },
    // Continuation turn — this hits maxTurns=2
    {
      type: 'tool_calls',
      calls: [{ id: 'c1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }],
    },
  ]);

  const { result } = await collectEvents(executor.run(submission, { maxTurns: 2 }));
  assert.equal(result.finalText, 'partial-');
});

// --- Observability Tests ---

test('recovery: done event always includes terminalReason for normal completion', async () => {
  const { executor } = makeExecutor([
    { type: 'final_text', text: 'ok' },
  ]);

  const { events } = await collectEvents(executor.run(submission));

  const doneEvent = events.find(e => e.type === 'done');
  assert.ok(doneEvent);
  assert.deepEqual((doneEvent as { terminalReason?: { reason: string } }).terminalReason, { reason: 'completed' });
});

test('recovery: retry events include attempt number and error type', async () => {
  const { executor } = makeExecutor([
    { error: { status: 429, message: 'Rate limited' } },
    { type: 'final_text', text: 'ok' },
  ]);

  const { events } = await collectEvents(executor.run(submission));

  const retryEvent = events.find(e => e.type === 'recovery' && (e as { reason: string }).reason === 'api_retry');
  assert.ok(retryEvent);
  const detail = (retryEvent as { detail?: { attempt: number; errorType: string } }).detail;
  assert.equal(detail?.attempt, 1);
  assert.equal(detail?.errorType, 'rate_limit');
});

test('recovery: fallback event includes from/to model names', async () => {
  const fallbackConfig = {
    ...testConfig,
    fallback_model: {
      provider: 'openai' as const,
      name: 'gpt-4o-mini',
      api_key: 'fallback-key',
      base_url: null,
      context_window_size: 128000,
      max_output_tokens: 4096,
    },
  };

  const { executor } = makeExecutor(
    [
      { error: { status: 529, message: 'Overloaded' } },
      { error: { status: 529, message: 'Overloaded' } },
      { error: { status: 529, message: 'Overloaded' } },
    ],
    [{ type: 'final_text', text: 'ok' }],
    fallbackConfig,
  );

  const { events } = await collectEvents(executor.run(submission));

  const fallbackEvent = events.find(e => e.type === 'recovery' && (e as { reason: string }).reason === 'fallback_model');
  assert.ok(fallbackEvent);
  const detail = (fallbackEvent as { detail?: { from: string; to: string } }).detail;
  assert.equal(detail?.from, 'gpt-4o');
  assert.equal(detail?.to, 'gpt-4o-mini');
});

test('recovery: max_output_recovery events include attempt numbers', async () => {
  const { executor } = makeExecutor([
    { type: 'final_text', text: 'A', truncated: true },
    { type: 'final_text', text: 'B', truncated: true },
    { type: 'final_text', text: 'C' },
  ]);

  const { events } = await collectEvents(executor.run(submission));

  const recoveryEvents = events.filter(
    e => e.type === 'recovery' && (e as { reason: string }).reason === 'max_output_recovery'
  );
  assert.equal(recoveryEvents.length, 2);
  assert.equal((recoveryEvents[0] as { detail?: { attempt: number } }).detail?.attempt, 1);
  assert.equal((recoveryEvents[1] as { detail?: { attempt: number } }).detail?.attempt, 2);
});

// --- Abort behavior ---

test('recovery: pre-aborted signal yields aborted terminal and returns gracefully', async () => {
  const { executor } = makeExecutor([
    { type: 'final_text', text: 'should not run' },
  ]);

  const controller = new AbortController();
  controller.abort();

  const { events } = await collectEvents(executor.run({ ...submission, signal: controller.signal }));
  const doneEvent = events.find(e => e.type === 'done') as { terminalReason?: { reason: string; phase?: string } } | undefined;
  assert.ok(doneEvent, 'done event must be emitted for pre-aborted signal');
  assert.equal(doneEvent?.terminalReason?.reason, 'aborted');
  assert.equal(doneEvent?.terminalReason?.phase, 'pre_loop');
});

// --- Normal path regression ---

test('recovery: normal final text path is unchanged', async () => {
  const { executor } = makeExecutor([
    { type: 'final_text', text: 'hello world', tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ]);

  const { events, result } = await collectEvents(executor.run(submission));

  assert.equal(result.finalText, 'hello world');
  assert.equal(result.completedTurns, 1);
  const textDelta = events.find(e => e.type === 'text_delta');
  assert.ok(textDelta);
});

test('recovery: normal tool call path is unchanged', async () => {
  const { executor } = makeExecutor([
    {
      type: 'tool_calls',
      calls: [{ id: 'c1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }],
    },
    { type: 'final_text', text: 'after tool' },
  ]);

  const { events, result } = await collectEvents(executor.run(submission));

  assert.equal(result.finalText, 'after tool');
  assert.ok(events.some(e => e.type === 'tool_start'));
  assert.ok(events.some(e => e.type === 'tool_end'));
});

// --- Track 04: Terminal reason semantics tests ---

test('recovery: model_error terminal reason emitted on unrecoverable model failure', async () => {
  // Auth errors (401) are non-retriable and should produce model_error
  const { executor } = makeExecutor([
    { error: { status: 401, message: 'Unauthorized' } },
  ]);

  const events: AgentEvent[] = [];
  const gen = executor.run(submission);
  try {
    await consumeGenerator(gen, (event) => events.push(event));
  } catch {
    // expected — auth errors propagate
  }

  const doneEvent = events.find(e => e.type === 'done') as { terminalReason?: { reason: string; error?: string } } | undefined;
  assert.ok(doneEvent, 'Should have a done event with model_error terminal reason');
  assert.equal(doneEvent?.terminalReason?.reason, 'model_error');
});

test('recovery: aborted terminal reason on pre-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();

  const { executor } = makeExecutor([
    { type: 'final_text', text: 'should not run' },
  ]);

  // Pre-aborted signal should yield aborted terminal reason and return (not throw)
  const events: AgentEvent[] = [];
  const gen = executor.run({ ...submission, signal: controller.signal });
  try {
    await consumeGenerator(gen, (event) => events.push(event));
  } catch {
    // abort may still throw in some paths
  }

  // Assert aborted terminal reason was emitted
  const doneEvent = events.find(e => e.type === 'done') as { terminalReason?: { reason: string; phase?: string } } | undefined;
  assert.ok(doneEvent, 'done event must be emitted for pre-aborted signal');
  assert.equal(doneEvent?.terminalReason?.reason, 'aborted');
});

test('recovery: apiRetryCount is tracked across retry attempts', async () => {
  // We verify indirectly: 2 retries then success should have produced
  // exactly 2 api_retry recovery events with incrementing attempt numbers
  const { executor } = makeExecutor([
    { error: { status: 429, message: 'Rate limited' } },
    { error: { status: 429, message: 'Rate limited' } },
    { type: 'final_text', text: 'ok' },
  ]);

  const { events } = await collectEvents(executor.run(submission));

  const retryEvents = events.filter(
    e => e.type === 'recovery' && (e as { reason: string }).reason === 'api_retry'
  );
  assert.equal(retryEvents.length, 2);
  // Attempt numbers should be 1 and 2
  assert.equal((retryEvents[0] as { detail?: { attempt: number } }).detail?.attempt, 1);
  assert.equal((retryEvents[1] as { detail?: { attempt: number } }).detail?.attempt, 2);
});
