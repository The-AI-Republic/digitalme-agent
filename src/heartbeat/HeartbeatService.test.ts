import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentConfig } from '../config/schema.js';
import { Agent } from '../agent/Agent.js';
import { HeartbeatService } from './HeartbeatService.js';

const config: AgentConfig = {
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
    base_url: 'http://platform.test',
    heartbeat_interval_seconds: 0.01,
  },
  model: {
    provider: 'openai',
    name: 'gpt-4o',
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
  quotas: { enabled: false, on_quota_exceeded: 'graceful_refuse', quota_warning_threshold: 0.8 },
  forked_agents: { enabled: true, max_concurrent: 2 },
  hooks: { post_turn: { enabled: true, timeout_ms: 30000 } },
};

test('HeartbeatService does not start overlapping heartbeat requests', async () => {
  const agent = new Agent(config, {
    sessionManager: {
      async execute() { throw new Error('not_used'); },
      getStats() { return { activeSessions: 0, activeTurns: 0, sessionTtlSeconds: 1800, maxActiveSessions: 1000, usage: { totalCostUsd: 0, dailyCostUsd: 0, monthlyCostUsd: 0 } }; },
      beginDrain() {},
    },
  });
  const service = new HeartbeatService(config, agent);

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return await new Promise<Response>(() => {});
  }) as typeof fetch;

  try {
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls, 1);
  } finally {
    service.stop();
    globalThis.fetch = originalFetch;
  }
});
