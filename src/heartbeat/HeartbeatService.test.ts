import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentConfig } from '../config/schema.js';
import { Agent } from '../agent/Agent.js';
import { HeartbeatService } from './HeartbeatService.js';

const config: AgentConfig = {
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
    base_url: 'http://platform.test',
    heartbeat_interval_seconds: 0.01,
  },
  model: {
    provider: 'openai',
    name: 'gpt-4o',
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
};

test('HeartbeatService does not start overlapping heartbeat requests', async () => {
  const agent = new Agent(config, {
    executor: {
      async execute() {
        throw new Error('not_used');
      },
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
