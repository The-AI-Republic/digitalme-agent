import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnExecutor } from '../agent/TurnExecutor.js';
import type { CompletionRequest, ModelStepResult } from './ModelClient.js';
import { ModelClient } from './ModelClient.js';
import { ModelRouter } from './ModelRouter.js';
import type { AgentEvent, TurnExecutionResult } from '../agent/types.js';
import { consumeGenerator } from '../agent/types.js';
import type { ISystemPromptBuilder, BuiltPrompt, PromptContext } from '../prompts/types.js';
import { testConfig } from '../test/fixtures.js';
import type { AgentConfig, ModelConfig } from '../config/schema.js';

// --- Stubs ---

class TrackingModelClient extends ModelClient {
  readonly calls: Array<{ model: string }> = [];
  constructor(
    readonly label: string,
    private readonly steps: ModelStepResult[],
  ) {
    super();
  }
  async generate(request: CompletionRequest): Promise<ModelStepResult> {
    this.calls.push({ model: request.model });
    const step = this.steps.shift();
    if (!step) throw new Error(`No more steps for ${this.label}`);
    return step;
  }
}

function makeFakeBuilder(): ISystemPromptBuilder {
  return {
    build(_context: PromptContext): BuiltPrompt {
      const content = 'test-system';
      return {
        sections: [{ name: 'test', content, cachePolicy: 'stable' as const, boundary: 'static' as const }],
        staticPrefix: [content],
        dynamicTail: [],
        finalSystemPrompt: [content],
      };
    },
    clearCache() {},
  };
}

function makeSubmission() {
  return {
    requestId: 'req-1',
    conversationId: 'conv-1',
    userMessage: 'hello',
    history: [],
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent, TurnExecutionResult>) {
  const events: AgentEvent[] = [];
  const result = await consumeGenerator(gen, (event) => events.push(event));
  return { events, result };
}

// --- Tests ---

test('TurnExecutor uses router to resolve primary model', async () => {
  const primaryClient = new TrackingModelClient('primary', [
    { type: 'final_text', text: 'hi' },
  ]);

  const router = new ModelRouter(testConfig, {
    createClient: () => primaryClient,
    createFromConfig: () => primaryClient,
  });

  const executor = new TurnExecutor(testConfig, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: {
      createClient: () => primaryClient,
      createFromConfig: () => primaryClient,
    },
    modelRouter: router,
  });

  const { result } = await collectEvents(executor.run(makeSubmission()));
  assert.equal(result.finalText, 'hi');
  assert.equal(primaryClient.calls.length, 1);
});

test('TurnExecutor records health events through router on success', async () => {
  const primaryClient = new TrackingModelClient('primary', [
    { type: 'final_text', text: 'hi' },
  ]);

  const router = new ModelRouter(testConfig, {
    createClient: () => primaryClient,
    createFromConfig: () => primaryClient,
  });

  const executor = new TurnExecutor(testConfig, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: {
      createClient: () => primaryClient,
      createFromConfig: () => primaryClient,
    },
    modelRouter: router,
  });

  await collectEvents(executor.run(makeSubmission()));

  const health = router.getProviderHealth('openai');
  assert.equal(health.successes, 1);
  assert.equal(health.failures, 0);
});

test('TurnExecutor records health events through router on failure', async () => {
  let callCount = 0;
  const failingClient = new (class extends ModelClient {
    async generate(_request: CompletionRequest): Promise<ModelStepResult> {
      callCount++;
      if (callCount <= 4) {
        const err = new Error('overloaded') as Error & { status: number };
        err.status = 529;
        throw err;
      }
      // This shouldn't be reached in this test since we only have 3 retries + 1 initial
      return { type: 'final_text', text: 'recovered' };
    }
  })();

  const router = new ModelRouter(testConfig, {
    createClient: () => failingClient,
    createFromConfig: () => failingClient,
  });

  const executor = new TurnExecutor(testConfig, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: {
      createClient: () => failingClient,
      createFromConfig: () => failingClient,
    },
    modelRouter: router,
  });

  try {
    await collectEvents(executor.run(makeSubmission()));
  } catch {
    // Expected — all retries exhausted
  }

  const health = router.getProviderHealth('openai');
  assert.ok(health.failures > 0);
});

test('TurnExecutor getRouter returns the router instance', () => {
  const primaryClient = new TrackingModelClient('primary', []);
  const router = new ModelRouter(testConfig, {
    createClient: () => primaryClient,
    createFromConfig: () => primaryClient,
  });

  const executor = new TurnExecutor(testConfig, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: {
      createClient: () => primaryClient,
      createFromConfig: () => primaryClient,
    },
    modelRouter: router,
  });

  assert.equal(executor.getRouter(), router);
});

test('TurnExecutor works without router (backwards compatible)', async () => {
  const primaryClient = new TrackingModelClient('primary', [
    { type: 'final_text', text: 'no-router' },
  ]);

  const executor = new TurnExecutor(testConfig, {
    systemPromptBuilder: makeFakeBuilder(),
    modelClientFactory: {
      createClient: () => primaryClient,
    },
  });

  const { result } = await collectEvents(executor.run(makeSubmission()));
  assert.equal(result.finalText, 'no-router');
  assert.equal(executor.getRouter(), undefined);
});

test('ModelRouter health-aware routing with fallback model config', async () => {
  const primaryClient = new TrackingModelClient('primary', [
    { type: 'final_text', text: 'from-primary' },
  ]);
  const fallbackClient = new TrackingModelClient('fallback', [
    { type: 'final_text', text: 'from-fallback' },
  ]);

  const fallbackModel: ModelConfig = {
    provider: 'anthropic',
    name: 'claude-sonnet',
    api_key: 'key2',
    base_url: null,
    max_output_tokens: 8192,
  };

  const configWithFallback: AgentConfig = {
    ...testConfig,
    fallback_model: fallbackModel,
  };

  const router = new ModelRouter(configWithFallback, {
    createClient: () => primaryClient,
    createFromConfig: (config: ModelConfig) => {
      if (config.provider === 'anthropic') return fallbackClient;
      return primaryClient;
    },
  }, {
    windowSize: 4,
    failureThreshold: 0.5,
    recoveryAfterSeconds: 60,
  });

  // Make openai unhealthy
  for (let i = 0; i < 4; i++) {
    router.recordFailure('openai', 'gpt-4o', 100, 'overloaded');
  }

  // Router should resolve to fallback
  const decision = router.resolve('primary');
  assert.equal(decision.modelConfig.provider, 'anthropic');
  assert.equal(decision.reason, 'fallback_health');
});
