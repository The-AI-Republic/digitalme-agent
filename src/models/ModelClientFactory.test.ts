import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentConfig } from '../config/schema.js';
import { ModelClientFactory } from './ModelClientFactory.js';
import { AnthropicClient } from './client/AnthropicClient.js';
import { GoogleCompletionClient } from './client/GoogleCompletionClient.js';
import { OpenAICompatibleClient } from './client/OpenAICompatibleClient.js';
import { OpenAIChatCompletionClient } from './client/OpenAIChatCompletionClient.js';

function makeConfig(modelProvider: AgentConfig['model']['provider']): AgentConfig {
  return {
    soul: {
      name: 'Test Agent',
      description: 'You are a test agent.',
      tools: {
        allow_web_search: false,
      },
    },
    server: {
      port: 8088,
      bind: '0.0.0.0',
    },
    auth: {
      api_key: 'key',
      signing_secret: 'secret',
    },
    platform: {
      base_url: null,
      heartbeat_interval_seconds: 20,
    },
    skills: {
      bundled_dir: './skills',
      local_dir: '/app/skills-local',
    },
    model: {
      provider: modelProvider,
      name: 'test-model',
      api_key: 'model-key',
      max_output_tokens: 8192,
      base_url: null,
    },
    limits: {
      max_message_length: 4000,
      max_history_messages: 100,
      max_turns: 10,
      max_concurrent: 50,
      max_pending: 1000,
      max_active_sessions: 1000,
      session_ttl_seconds: 1800,
    },
    security: {
      hmac_tolerance_seconds: 300,
    },
    context: {
      model_metadata: {},
      default_context_window_size: 128000,
      default_max_output_tokens: 4096,
      microcompact: { enabled: true, gap_threshold_minutes: 60, keep_recent_results: 5 },
      tool_result_persistence: { enabled: true, default_max_result_chars: 10000, per_message_budget_chars: 30000, preview_size_bytes: 2000, storage_dir: '/tmp/digitalme-agent-test' },
      session_memory: { enabled: false, extraction_model: null, tokens_between_updates: 5000, tool_calls_between_updates: 3, minimum_tokens_to_init: 10000, max_total_tokens: 8000, max_section_tokens: 1500 },
      summary: { enabled: true, model: null, max_summary_tokens: 2000, preserve_recent_messages: 10 },
      thresholds: { microcompact_ratio: 0.5, projection_ratio: 0.7, overflow_ratio: 0.9, safety_margin: 1.33 },
      reactive_compact: { max_retries: 1, aggressive_preserve_messages: 3 },
      max_output_recovery: { max_retries: 2 },
    },
    forked_agents: { enabled: true, max_concurrent: 2 },
    hooks: { post_turn: { enabled: true, timeout_ms: 30000 } },
  };
}

test('ModelClientFactory creates the native OpenAI client for openai', () => {
  const client = new ModelClientFactory(makeConfig('openai')).createClient();
  assert.ok(client instanceof OpenAIChatCompletionClient);
});

test('ModelClientFactory creates the Anthropic client for anthropic', () => {
  const client = new ModelClientFactory(makeConfig('anthropic')).createClient();
  assert.ok(client instanceof AnthropicClient);
});

test('ModelClientFactory creates the native Google client for google-ai-studio', () => {
  const client = new ModelClientFactory(makeConfig('google-ai-studio')).createClient();
  assert.ok(client instanceof GoogleCompletionClient);
});

test('ModelClientFactory creates OpenAI-compatible clients for compatible providers', () => {
  for (const provider of ['xai', 'groq', 'fireworks', 'together'] as const) {
    const client = new ModelClientFactory(makeConfig(provider)).createClient();
    assert.ok(client instanceof OpenAICompatibleClient);
  }
});

test('ModelClientFactory reuses a client instance across calls', () => {
  const factory = new ModelClientFactory(makeConfig('openai'));
  assert.equal(factory.createClient(), factory.createClient());
});
