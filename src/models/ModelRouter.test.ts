import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentConfig, ModelConfig } from '../config/schema.js';
import { ModelClient, type CompletionRequest, type ModelStepResult } from './ModelClient.js';
import { ModelRouter } from './ModelRouter.js';
import type { IModelClientFactory } from './ModelClientFactory.js';

// --- Stub client ---

class StubClient extends ModelClient {
  constructor(readonly label: string) { super(); }
  async generate(_request: CompletionRequest): Promise<ModelStepResult> {
    return { type: 'final_text', text: `from ${this.label}` };
  }
}

// --- Stub factory ---

function makeFactory(primary: StubClient): IModelClientFactory {
  return {
    createClient: () => primary,
    createFromConfig: (config: ModelConfig) => new StubClient(`${config.provider}/${config.name}`),
  };
}

// --- Config builders ---

const primaryModel: ModelConfig = {
  provider: 'openai',
  name: 'gpt-4o',
  api_key: 'key',
  base_url: null,
  max_output_tokens: 8192,
};

const fallbackModel: ModelConfig = {
  provider: 'anthropic',
  name: 'claude-sonnet',
  api_key: 'key2',
  base_url: null,
  max_output_tokens: 8192,
};

const summaryModel: ModelConfig = {
  provider: 'openai',
  name: 'gpt-4o-mini',
  api_key: 'key',
  base_url: null,
  max_output_tokens: 4096,
};

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    soul: { name: 'Test', description: 'Test agent', tools: { allow_web_search: false } },
    server: { port: 8088, bind: '0.0.0.0' },
    auth: { api_key: 'key', signing_secret: 'secret' },
    platform: { base_url: null, heartbeat_interval_seconds: 20 },
    model: primaryModel,
    limits: { max_message_length: 4000, max_history_messages: 100, max_turns: 10, max_concurrent: 50, max_pending: 1000, max_active_sessions: 1000, session_ttl_seconds: 1800 },
    security: { hmac_tolerance_seconds: 300 },
    context: {
      model_metadata: {},
      default_context_window_size: 128000,
      default_max_output_tokens: 4096,
      microcompact: { enabled: true, gap_threshold_minutes: 60, keep_recent_results: 5 },
      tool_result_persistence: { enabled: true, default_max_result_chars: 10000, per_message_budget_chars: 30000, preview_size_bytes: 2000, storage_dir: '/tmp/test' },
      session_memory: { enabled: false, extraction_model: null, tokens_between_updates: 5000, tool_calls_between_updates: 3, minimum_tokens_to_init: 10000, max_total_tokens: 8000, max_section_tokens: 1500 },
      summary: { enabled: true, model: null, max_summary_tokens: 2000, preserve_recent_messages: 10 },
      thresholds: { microcompact_ratio: 0.5, projection_ratio: 0.7, overflow_ratio: 0.9, safety_margin: 1.33 },
      reactive_compact: { max_retries: 1, aggressive_preserve_messages: 3 },
      max_output_recovery: { max_retries: 2 },
    },
    skills: { bundled_dir: './skills', local_dir: '/app/skills-local' },
    quotas: { enabled: false, on_quota_exceeded: 'graceful_refuse', quota_warning_threshold: 0.8 },
    routing: { task_models: {}, health: { enabled: true, window_size: 20, failure_threshold: 0.5, recovery_after_seconds: 60 } },
    forked_agents: { enabled: true, max_concurrent: 2 },
    hooks: { post_turn: { enabled: true, timeout_ms: 30000 } },
    ...overrides,
  };
}

// --- resolve() tests ---

test('ModelRouter: resolves primary model for primary task', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  const decision = router.resolve('primary');
  assert.equal(decision.modelConfig.name, 'gpt-4o');
  assert.equal(decision.reason, 'config_primary');
  assert.equal(decision.task, 'primary');
});

test('ModelRouter: resolves fallback model for fallback task', () => {
  const factory = makeFactory(new StubClient('primary'));
  const config = makeConfig({ fallback_model: fallbackModel });
  const router = new ModelRouter(config, factory);

  const decision = router.resolve('fallback');
  assert.equal(decision.modelConfig.name, 'claude-sonnet');
  assert.equal(decision.reason, 'config_task_specific');
  assert.equal(decision.task, 'fallback');
});

test('ModelRouter: falls back to primary when no task-specific model configured', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  const decision = router.resolve('summary');
  assert.equal(decision.modelConfig.name, 'gpt-4o');
  assert.equal(decision.reason, 'fallback_not_configured');
  assert.equal(decision.task, 'summary');
});

test('ModelRouter: resolves task-specific model from routing config', () => {
  const factory = makeFactory(new StubClient('primary'));
  const config = makeConfig({
    routing: {
      task_models: { summary: summaryModel },
      health: { enabled: true, window_size: 20, failure_threshold: 0.5, recovery_after_seconds: 60 },
    },
  } as Partial<AgentConfig>);
  const router = new ModelRouter(config, factory);

  const decision = router.resolve('summary');
  assert.equal(decision.modelConfig.name, 'gpt-4o-mini');
  assert.equal(decision.reason, 'config_task_specific');
});

test('ModelRouter: extraction task falls back to primary when not configured', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  const decision = router.resolve('extraction');
  assert.equal(decision.modelConfig.name, 'gpt-4o');
  assert.equal(decision.reason, 'fallback_not_configured');
});

test('ModelRouter: forked task falls back to primary when not configured', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  const decision = router.resolve('forked');
  assert.equal(decision.modelConfig.name, 'gpt-4o');
  assert.equal(decision.reason, 'fallback_not_configured');
});

// --- resolveClient() tests ---

test('ModelRouter: resolveClient returns a client and decision', () => {
  const primary = new StubClient('primary');
  const factory = makeFactory(primary);
  const router = new ModelRouter(makeConfig(), factory);

  const { client, decision } = router.resolveClient('primary');
  assert.ok(client instanceof StubClient);
  assert.equal(decision.modelConfig.name, 'gpt-4o');
});

test('ModelRouter: resolveClient caches clients by config key', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  const { client: client1 } = router.resolveClient('primary');
  const { client: client2 } = router.resolveClient('primary');
  assert.equal(client1, client2); // Same instance
});

test('ModelRouter: different configs get different cached clients', () => {
  const factory = makeFactory(new StubClient('primary'));
  const config = makeConfig({
    fallback_model: fallbackModel,
    routing: {
      task_models: { summary: summaryModel },
      health: { enabled: true, window_size: 20, failure_threshold: 0.5, recovery_after_seconds: 60 },
    },
  } as Partial<AgentConfig>);
  const router = new ModelRouter(config, factory);

  const { client: primaryClient } = router.resolveClient('primary');
  const { client: summaryClient } = router.resolveClient('summary');
  assert.notEqual(primaryClient, summaryClient);
});

// --- Health-aware routing ---

test('ModelRouter: routes to fallback when primary provider is unhealthy', () => {
  const factory = makeFactory(new StubClient('primary'));
  const config = makeConfig({
    fallback_model: fallbackModel,
    routing: { task_models: {}, health: { enabled: true, window_size: 4, failure_threshold: 0.5, recovery_after_seconds: 60 } },
  });
  const router = new ModelRouter(config, factory);

  // Make openai unhealthy
  for (let i = 0; i < 4; i++) {
    router.recordFailure('openai', 'gpt-4o', 100, 'overloaded');
  }

  const decision = router.resolve('primary');
  assert.equal(decision.modelConfig.name, 'claude-sonnet');
  assert.equal(decision.reason, 'fallback_health');
});

test('ModelRouter: uses primary when all providers unhealthy', () => {
  const factory = makeFactory(new StubClient('primary'));
  const config = makeConfig({
    fallback_model: fallbackModel,
    routing: { task_models: {}, health: { enabled: true, window_size: 4, failure_threshold: 0.5, recovery_after_seconds: 60 } },
  });
  const router = new ModelRouter(config, factory);

  // Make both providers unhealthy
  for (let i = 0; i < 4; i++) {
    router.recordFailure('openai', 'gpt-4o', 100, 'overloaded');
    router.recordFailure('anthropic', 'claude-sonnet', 100, 'overloaded');
  }

  const decision = router.resolve('primary');
  assert.equal(decision.modelConfig.name, 'gpt-4o'); // Falls back to primary
  assert.equal(decision.reason, 'config_primary');
});

test('ModelRouter: health-aware routing for task-specific models', () => {
  const factory = makeFactory(new StubClient('primary'));
  const config = makeConfig({
    fallback_model: fallbackModel,
    routing: {
      task_models: { summary: summaryModel },
      health: { enabled: true, window_size: 4, failure_threshold: 0.5, recovery_after_seconds: 60 },
    },
  } as Partial<AgentConfig>);
  const router = new ModelRouter(config, factory);

  // Make the summary model's provider (openai) unhealthy
  for (let i = 0; i < 4; i++) {
    router.recordFailure('openai', 'gpt-4o-mini', 100, 'overloaded');
  }

  // Should route to fallback since openai is unhealthy
  const decision = router.resolve('summary');
  assert.equal(decision.modelConfig.name, 'claude-sonnet');
  assert.equal(decision.reason, 'fallback_health');
});

// --- Health recording ---

test('ModelRouter: recordSuccess updates health tracker', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  router.recordSuccess('openai', 'gpt-4o', 150);

  const health = router.getProviderHealth('openai');
  assert.equal(health.successes, 1);
  assert.equal(health.avgLatencyMs, 150);
});

test('ModelRouter: recordFailure updates health tracker', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  router.recordFailure('openai', 'gpt-4o', 200, 'rate_limit');

  const health = router.getProviderHealth('openai');
  assert.equal(health.failures, 1);
});

test('ModelRouter: getAllProviderHealth returns all provider snapshots', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  router.recordSuccess('openai', 'gpt-4o', 100);
  router.recordFailure('anthropic', 'claude-sonnet', 200, 'overloaded');

  const snapshots = router.getAllProviderHealth();
  assert.equal(snapshots.length, 2);
});

test('ModelRouter: isProviderHealthy delegates to health tracker', () => {
  const factory = makeFactory(new StubClient('primary'));
  const config = makeConfig({
    routing: { task_models: {}, health: { enabled: true, window_size: 4, failure_threshold: 0.5, recovery_after_seconds: 60 } },
  });
  const router = new ModelRouter(config, factory);

  assert.ok(router.isProviderHealthy('openai'));

  for (let i = 0; i < 4; i++) {
    router.recordFailure('openai', 'gpt-4o', 100);
  }

  assert.ok(!router.isProviderHealthy('openai'));
});

// --- Reset ---

test('ModelRouter: reset clears health data and client cache', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  router.recordSuccess('openai', 'gpt-4o', 100);
  router.resolveClient('primary'); // Populate client cache

  router.reset();

  assert.equal(router.getAllProviderHealth().length, 0);
  // After reset, resolveClient should create a fresh client
  const { client } = router.resolveClient('primary');
  assert.ok(client instanceof StubClient);
});

// --- getOrCreateClient ---

test('ModelRouter: getOrCreateClient caches by provider+name+base_url+api_key', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  const client1 = router.getOrCreateClient(primaryModel);
  const client2 = router.getOrCreateClient(primaryModel);
  assert.equal(client1, client2);

  const client3 = router.getOrCreateClient(fallbackModel);
  assert.notEqual(client1, client3);
});

test('ModelRouter: getOrCreateClient differentiates by base_url', () => {
  const factory = makeFactory(new StubClient('primary'));
  const router = new ModelRouter(makeConfig(), factory);

  const model1: ModelConfig = { ...primaryModel, base_url: null };
  const model2: ModelConfig = { ...primaryModel, base_url: 'https://custom.api.com' };

  const client1 = router.getOrCreateClient(model1);
  const client2 = router.getOrCreateClient(model2);
  assert.notEqual(client1, client2);
});

// --- No fallback configured ---

test('ModelRouter: without fallback, unhealthy primary still returns primary', () => {
  const factory = makeFactory(new StubClient('primary'));
  const config = makeConfig({
    routing: { task_models: {}, health: { enabled: true, window_size: 4, failure_threshold: 0.5, recovery_after_seconds: 60 } },
  }); // No fallback_model
  const router = new ModelRouter(config, factory);

  for (let i = 0; i < 4; i++) {
    router.recordFailure('openai', 'gpt-4o', 100);
  }

  const decision = router.resolve('primary');
  assert.equal(decision.modelConfig.name, 'gpt-4o');
  assert.equal(decision.reason, 'config_primary');
});

// --- Recovery from unhealthy state ---

test('ModelRouter: provider recovers after success', () => {
  const factory = makeFactory(new StubClient('primary'));
  const config = makeConfig({
    fallback_model: fallbackModel,
    routing: { task_models: {}, health: { enabled: true, window_size: 4, failure_threshold: 0.5, recovery_after_seconds: 60 } },
  });
  const router = new ModelRouter(config, factory);

  // Make openai unhealthy
  for (let i = 0; i < 4; i++) {
    router.recordFailure('openai', 'gpt-4o', 100);
  }
  assert.ok(!router.isProviderHealthy('openai'));

  // Record a success
  router.recordSuccess('openai', 'gpt-4o', 100);
  assert.ok(router.isProviderHealthy('openai'));

  // Should route back to primary
  const decision = router.resolve('primary');
  assert.equal(decision.modelConfig.name, 'gpt-4o');
});
