import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentConfig } from '../config/schema.js';
import { ModelClientFactory } from './ModelClientFactory.js';
import { GoogleCompletionClient } from './client/GoogleCompletionClient.js';
import { OpenAICompatibleClient } from './client/OpenAICompatibleClient.js';
import { OpenAIChatCompletionClient } from './client/OpenAIChatCompletionClient.js';

function makeConfig(modelProvider: AgentConfig['model']['provider']): AgentConfig {
  return {
    persona: {
      name: 'Test Agent',
      default_system_prompt: 'You are a test agent.',
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
    model: {
      provider: modelProvider,
      name: 'test-model',
      api_key: 'model-key',
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
    guardrails: {
      enabled: false,
      blocked_keywords: [],
      response_rules: { max_response_length: 2000, block_external_links: false },
      pii_detection: { enabled: false, block_in_input: true, block_in_output: true },
      jailbreak_detection: { enabled: false },
      messages: {
        input_blocked: "I can't respond to that. Let me know if there's something else I can help with!",
        output_blocked: "Sorry, I wasn't able to generate a suitable response. Please try again.",
      },
    },
  };
}

test('ModelClientFactory creates the native OpenAI client for openai', () => {
  const client = new ModelClientFactory(makeConfig('openai')).createClient();
  assert.ok(client instanceof OpenAIChatCompletionClient);
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
