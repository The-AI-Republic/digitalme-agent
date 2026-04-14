import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';

import type { AddressInfo } from 'node:net';

import type { AgentConfig } from './config/schema.js';
import { Agent } from './agent/Agent.js';
import { createServer } from './server.js';
import type { EventQueue } from './agent/EventQueue.js';
import type { AgentEvent, TurnSubmission } from './agent/types.js';

const TEST_CONFIG: AgentConfig = {
  soul: {
    name: 'Test Creator',
    description: 'You are a helpful creator agent.',
    tools: {
      allow_web_search: false,
    },
  },
  server: {
    port: 0,
    bind: '127.0.0.1',
  },
  auth: {
    api_key: 'test-key',
    signing_secret: 'test-secret',
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
    provider: 'openai',
    name: 'gpt-4o',
    api_key: 'unused',
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
  routing: { task_models: {}, health: { enabled: true, window_size: 20, failure_threshold: 0.5, recovery_after_seconds: 60 } },
  forked_agents: { enabled: true, max_concurrent: 2 },
  hooks: { post_turn: { enabled: true, timeout_ms: 30000 } },
};

function buildHeaders(body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', TEST_CONFIG.auth.signing_secret)
    .update(`${timestamp}:${body}`)
    .digest('hex');

  return {
    'Content-Type': 'application/json',
    'X-DigitalMe-Key': TEST_CONFIG.auth.api_key,
    'X-DigitalMe-Signature': signature,
    'X-DigitalMe-Timestamp': timestamp,
  };
}

async function startTestServer(agent: Agent) {
  const app = createServer(TEST_CONFIG, agent);
  const server = app.listen(TEST_CONFIG.server.port, TEST_CONFIG.server.bind);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://${TEST_CONFIG.server.bind}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function readSse(response: Response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => JSON.parse(chunk.replace(/^data:\s*/, '')) as AgentEvent);
}

test('POST /verify echoes the signed challenge', async () => {
  const agent = new Agent(TEST_CONFIG, {
    sessionManager: {
      async execute() { throw new Error('not_used'); },
      getStats() { return { activeSessions: 0, activeTurns: 0, sessionTtlSeconds: 1800, maxActiveSessions: 1000 }; },
      beginDrain() {},
    },
  });
  const server = await startTestServer(agent);

  try {
    const body = JSON.stringify({
      type: 'verification',
      challenge: 'hello-world',
    });
    const response = await fetch(`${server.baseUrl}/verify`, {
      method: 'POST',
      headers: buildHeaders(body),
      body,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { challenge: 'hello-world' });
  } finally {
    await server.close();
  }
});

test('POST /v1/task streams tool and terminal events over SSE', async () => {
  const eventsToEmit: AgentEvent[] = [
    { type: 'tool_start', name: 'web_search', callId: 'call_1' },
    { type: 'tool_end', name: 'web_search', callId: 'call_1', success: true },
    { type: 'text_delta', content: 'Answer ready.' },
    { type: 'done' },
  ];

  const agent = new Agent(TEST_CONFIG, {
    sessionManager: {
      async execute(_submission: TurnSubmission, events: EventQueue<AgentEvent>) {
        for (const event of eventsToEmit) {
          events.push(event);
        }
      },
      getStats() { return { activeSessions: 0, activeTurns: 0, sessionTtlSeconds: 1800, maxActiveSessions: 1000 }; },
      beginDrain() {},
    },
  });
  const server = await startTestServer(agent);

  try {
    const body = JSON.stringify({
      request_id: 'req_123',
      conversation_id: 'conv_456',
      message: 'Hello',
      history: [{ role: 'user', content: 'Earlier' }],
    });
    const response = await fetch(`${server.baseUrl}/v1/task`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        ...buildHeaders(body),
      },
      body,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.deepEqual(await readSse(response), eventsToEmit);
  } finally {
    await server.close();
  }
});

test('POST /v1/task rejects replayed requests with stale timestamps', async () => {
  const agent = new Agent(TEST_CONFIG, {
    sessionManager: {
      async execute() { throw new Error('not_used'); },
      getStats() { return { activeSessions: 0, activeTurns: 0, sessionTtlSeconds: 1800, maxActiveSessions: 1000 }; },
      beginDrain() {},
    },
  });
  const server = await startTestServer(agent);

  try {
    const body = JSON.stringify({
      request_id: 'req_replay',
      conversation_id: 'conv_replay',
      message: 'Hello',
      history: [],
    });
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - TEST_CONFIG.security.hmac_tolerance_seconds - 60);
    const signature = crypto
      .createHmac('sha256', TEST_CONFIG.auth.signing_secret)
      .update(`${staleTimestamp}:${body}`)
      .digest('hex');

    const response = await fetch(`${server.baseUrl}/v1/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DigitalMe-Key': TEST_CONFIG.auth.api_key,
        'X-DigitalMe-Signature': signature,
        'X-DigitalMe-Timestamp': staleTimestamp,
      },
      body,
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'replay_rejected' });
  } finally {
    await server.close();
  }
});

test('POST /v1/task rejects invalid signatures before opening SSE', async () => {
  const agent = new Agent(TEST_CONFIG, {
    sessionManager: {
      async execute() { throw new Error('not_used'); },
      getStats() { return { activeSessions: 0, activeTurns: 0, sessionTtlSeconds: 1800, maxActiveSessions: 1000 }; },
      beginDrain() {},
    },
  });
  const server = await startTestServer(agent);

  try {
    const body = JSON.stringify({
      request_id: 'req_unauthorized',
      conversation_id: 'conv_unauthorized',
      message: 'Hello',
      history: [],
    });
    const response = await fetch(`${server.baseUrl}/v1/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DigitalMe-Key': TEST_CONFIG.auth.api_key,
        'X-DigitalMe-Signature': 'invalid',
        'X-DigitalMe-Timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body,
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  } finally {
    await server.close();
  }
});
