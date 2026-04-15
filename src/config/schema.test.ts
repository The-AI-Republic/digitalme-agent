import assert from 'node:assert/strict';
import test from 'node:test';
import { agentConfigSchema, historyMessageSchema } from './schema.js';

// ---------- historyMessageSchema ----------

test('historyMessageSchema accepts valid user message', () => {
  const result = historyMessageSchema.safeParse({ role: 'user', content: 'hello' });
  assert.equal(result.success, true);
});

test('historyMessageSchema accepts valid assistant message', () => {
  const result = historyMessageSchema.safeParse({ role: 'assistant', content: 'hi' });
  assert.equal(result.success, true);
});

test('historyMessageSchema rejects system role', () => {
  const result = historyMessageSchema.safeParse({ role: 'system', content: 'hi' });
  assert.equal(result.success, false);
});

test('historyMessageSchema rejects content exceeding 100k chars', () => {
  const result = historyMessageSchema.safeParse({ role: 'user', content: 'x'.repeat(100_001) });
  assert.equal(result.success, false);
});

// ---------- agentConfigSchema ----------

test('agentConfigSchema accepts a valid full config', () => {
  const input = {
    soul: {
      name: 'Test',
      description: 'You are a test agent.',
    },
    server: {},
    auth: { api_key: 'key', signing_secret: 'secret' },
    model: { provider: 'openai', name: 'gpt-4o', api_key: 'model-key', context_window_size: 128000 },
    limits: {},
    security: {},
  };
  const result = agentConfigSchema.safeParse(input);
  assert.equal(result.success, true);
  if (result.success) {
    // Check defaults are applied
    assert.equal(result.data.server.port, 8088);
    assert.equal(result.data.server.bind, '0.0.0.0');
    assert.equal(result.data.soul.tools.allow_web_search, false);
    assert.equal(result.data.limits.max_message_length, 4000);
    assert.equal(result.data.limits.max_concurrent, 50);
    assert.equal(result.data.security.hmac_tolerance_seconds, 300);
    assert.equal(result.data.platform.heartbeat_interval_seconds, 20);
  }
});

test('agentConfigSchema rejects missing soul name', () => {
  const input = {
    soul: { name: '', description: 'a description' },
    server: {},
    auth: { api_key: 'key', signing_secret: 'secret' },
    model: { provider: 'openai', name: 'gpt-4o', api_key: 'model-key', context_window_size: 128000 },
    limits: {},
    security: {},
  };
  const result = agentConfigSchema.safeParse(input);
  assert.equal(result.success, false);
});

test('agentConfigSchema rejects missing auth fields', () => {
  const input = {
    soul: { name: 'Test', description: 'a description' },
    server: {},
    auth: {},
    model: { provider: 'openai', name: 'gpt-4o', api_key: 'model-key', context_window_size: 128000 },
    limits: {},
    security: {},
  };
  const result = agentConfigSchema.safeParse(input);
  assert.equal(result.success, false);
});

test('agentConfigSchema accepts anthropic as valid provider', () => {
  const input = {
    soul: { name: 'Test', description: 'a description' },
    server: {},
    auth: { api_key: 'key', signing_secret: 'secret' },
    model: { provider: 'anthropic', name: 'claude-sonnet-4-6', api_key: 'key', context_window_size: 200000 },
    limits: {},
    security: {},
  };
  const result = agentConfigSchema.safeParse(input);
  assert.equal(result.success, true);
});

test('agentConfigSchema accepts all valid model providers', () => {
  const providers = ['openai', 'anthropic', 'xai', 'groq', 'google-ai-studio', 'fireworks', 'together'] as const;
  for (const provider of providers) {
    const input = {
      soul: { name: 'Test', description: 'a description' },
      server: {},
      auth: { api_key: 'key', signing_secret: 'secret' },
      model: { provider, name: 'model-name', api_key: 'key', context_window_size: 128000 },
      limits: {},
      security: {},
    };
    const result = agentConfigSchema.safeParse(input);
    assert.equal(result.success, true, `provider '${provider}' should be accepted`);
  }
});

test('agentConfigSchema rejects negative port', () => {
  const input = {
    soul: { name: 'Test', description: 'a description' },
    server: { port: -1 },
    auth: { api_key: 'key', signing_secret: 'secret' },
    model: { provider: 'openai', name: 'gpt-4o', api_key: 'key', context_window_size: 128000 },
    limits: {},
    security: {},
  };
  const result = agentConfigSchema.safeParse(input);
  assert.equal(result.success, false);
});

test('agentConfigSchema accepts optional nullable platform base_url', () => {
  const input = {
    soul: { name: 'Test', description: 'a description' },
    server: {},
    auth: { api_key: 'key', signing_secret: 'secret' },
    platform: { base_url: null },
    model: { provider: 'openai', name: 'gpt-4o', api_key: 'key', context_window_size: 128000 },
    limits: {},
    security: {},
  };
  const result = agentConfigSchema.safeParse(input);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.platform.base_url, null);
  }
});

test('agentConfigSchema rejects blank blocked keywords', () => {
  const input = {
    soul: { name: 'Test', description: 'a description' },
    server: {},
    auth: { api_key: 'key', signing_secret: 'secret' },
    model: { provider: 'openai', name: 'gpt-4o', api_key: 'key', context_window_size: 128000 },
    limits: {},
    security: {},
    guardrails: {
      blocked_keywords: ['   '],
    },
  };
  const result = agentConfigSchema.safeParse(input);
  assert.equal(result.success, false);
});

test('agentConfigSchema accepts soul with optional fields', () => {
  const input = {
    soul: {
      name: 'Test',
      description: 'a description',
      tone: 'warm and friendly',
      boundaries: 'no politics',
      knowledge: 'cooking expert',
      others: 'loves cats',
      system_prompt_append: 'Always be helpful.',
    },
    server: {},
    auth: { api_key: 'key', signing_secret: 'secret' },
    model: { provider: 'openai', name: 'gpt-4o', api_key: 'key', context_window_size: 128000 },
    limits: {},
    security: {},
  };
  const result = agentConfigSchema.safeParse(input);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.soul.tone, 'warm and friendly');
    assert.equal(result.data.soul.boundaries, 'no politics');
    assert.equal(result.data.soul.knowledge, 'cooking expert');
    assert.equal(result.data.soul.system_prompt_append, 'Always be helpful.');
  }
});

test('agentConfigSchema accepts subagents config', () => {
  const input = {
    soul: { name: 'Test', description: 'a description' },
    server: {},
    auth: { api_key: 'key', signing_secret: 'secret' },
    model: { provider: 'openai', name: 'gpt-4o', api_key: 'key', context_window_size: 128000 },
    limits: {},
    security: {},
    subagents: { enabled: true, max_concurrent: 3 },
  };
  const result = agentConfigSchema.safeParse(input);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.subagents.enabled, true);
    assert.equal(result.data.subagents.max_concurrent, 3);
  }
});
