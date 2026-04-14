/**
 * Tests for guardrailScope enforcement in TurnExecutor.
 *
 * Covers:
 * - Track 10: guardrailScope 'internal' skips guardrails
 * - Track 10: guardrailScope 'public' (default) enforces guardrails
 * - Track 10: Refusal text persistence in input blocked flows
 * - Track 10: Partial text validation during max-output recovery
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from './TurnExecutor.js';
import type { CompletionRequest, ModelStepResult, ModelClient } from '../models/ModelClient.js';
import type { AgentEvent, TurnSubmission, ExecutionOptions } from './types.js';
import { consumeGenerator } from './types.js';
import type { ISystemPromptBuilder, BuiltPrompt, PromptContext } from '../prompts/types.js';
import { testConfig } from '../test/fixtures.js';
import type { AgentConfig } from '../config/schema.js';

class FakeModelClient implements ModelClient {
  constructor(private responses: ModelStepResult[]) {}
  async generate(_request: CompletionRequest): Promise<ModelStepResult> {
    return this.responses.shift()!;
  }
}

function makeBuilder(): ISystemPromptBuilder {
  return {
    build: (_ctx: PromptContext): BuiltPrompt => ({
      finalSystemPrompt: ['You are a test agent.'],
      sections: [{ name: 'test', content: 'You are a test agent.', cachePolicy: 'volatile' as const, boundary: 'dynamic' as const }],
      staticPrefix: ['You are a test agent.'],
      dynamicTail: [],
    }),
    clearCache: () => {},
  };
}

function makeFactory(client: FakeModelClient) {
  return {
    createClient() { return client; },
    createFromConfig() { return client; },
  };
}

function makeSubmission(overrides: Partial<TurnSubmission> = {}): TurnSubmission {
  return {
    requestId: 'req-1',
    conversationId: 'conv-1',
    userMessage: 'hello',
    history: [],
    ...overrides,
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent, any>): Promise<{ events: AgentEvent[]; result: any }> {
  const events: AgentEvent[] = [];
  let iterResult = await gen.next();
  while (!iterResult.done) {
    events.push(iterResult.value);
    iterResult = await gen.next();
  }
  return { events, result: iterResult.value };
}

// Config with guardrails enabled
const guardrailedConfig: AgentConfig = {
  ...testConfig,
  guardrails: {
    ...testConfig.guardrails,
    enabled: true,
    blocked_keywords: ['forbidden'],
    jailbreak_detection: { enabled: true },
    pii_detection: { enabled: false, block_in_input: false, block_in_output: false },
    messages: {
      input_blocked: 'Your message was blocked.',
      output_blocked: 'Response blocked.',
    },
  },
};

test('guardrailScope internal skips input guardrails', async () => {
  const client = new FakeModelClient([
    { type: 'final_text', text: 'response', tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ]);
  const executor = new TurnExecutor(guardrailedConfig, {
    systemPromptBuilder: makeBuilder(),
    modelClientFactory: makeFactory(client),
  });

  const options: ExecutionOptions = { guardrailScope: 'internal' };
  const { events, result } = await collectEvents(
    executor.run(makeSubmission({ userMessage: 'forbidden word here' }), options),
  );

  // Should NOT be blocked — internal scope skips guardrails
  assert.equal(result.finalText, 'response');
  const blockEvents = events.filter((e) => e.type === 'guardrail_block');
  assert.equal(blockEvents.length, 0);
});

test('guardrailScope public blocks forbidden input', async () => {
  const client = new FakeModelClient([
    { type: 'final_text', text: 'response', tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ]);
  const executor = new TurnExecutor(guardrailedConfig, {
    systemPromptBuilder: makeBuilder(),
    modelClientFactory: makeFactory(client),
  });

  const { events, result } = await collectEvents(
    executor.run(makeSubmission({ userMessage: 'this contains forbidden keyword' })),
  );

  // Should be blocked
  assert.equal(result.finalText, 'Your message was blocked.');
  const blockEvents = events.filter((e) => e.type === 'guardrail_block');
  assert.equal(blockEvents.length, 1);
  assert.equal(blockEvents[0].type, 'guardrail_block');
});

test('input block persists refusal assistant message in newMessages', async () => {
  const client = new FakeModelClient([]);
  const executor = new TurnExecutor(guardrailedConfig, {
    systemPromptBuilder: makeBuilder(),
    modelClientFactory: makeFactory(client),
  });

  const { result } = await collectEvents(
    executor.run(makeSubmission({ userMessage: 'forbidden' })),
  );

  // newMessages should include both user message and refusal assistant message
  const assistantMessages = result.newMessages.filter((m: any) => m.role === 'assistant');
  assert.ok(assistantMessages.length >= 1, 'Should have at least one assistant refusal message');
  assert.equal(assistantMessages[0].content, 'Your message was blocked.');
  assert.equal(assistantMessages[0].synthetic, true);
});

test('guardrailScope internal skips output guardrails', async () => {
  const client = new FakeModelClient([
    { type: 'final_text', text: 'response with forbidden word', tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ]);
  const executor = new TurnExecutor(guardrailedConfig, {
    systemPromptBuilder: makeBuilder(),
    modelClientFactory: makeFactory(client),
  });

  const options: ExecutionOptions = { guardrailScope: 'internal' };
  const { events, result } = await collectEvents(
    executor.run(makeSubmission(), options),
  );

  // Output should pass through unmodified — internal scope skips guardrails
  assert.equal(result.finalText, 'response with forbidden word');
  const blockEvents = events.filter((e) => e.type === 'guardrail_block');
  assert.equal(blockEvents.length, 0);
});

test('default guardrailScope is public', async () => {
  const client = new FakeModelClient([
    { type: 'final_text', text: 'response with forbidden word', tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ]);
  const executor = new TurnExecutor(guardrailedConfig, {
    systemPromptBuilder: makeBuilder(),
    modelClientFactory: makeFactory(client),
  });

  // No options = default public scope
  const { events, result } = await collectEvents(
    executor.run(makeSubmission()),
  );

  // Output should be blocked (default is public)
  assert.equal(result.finalText, 'Response blocked.');
  const blockEvents = events.filter((e) => e.type === 'guardrail_block');
  assert.equal(blockEvents.length, 1);
});
