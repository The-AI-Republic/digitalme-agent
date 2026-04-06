import type { AgentConfig } from '../config/schema.js';

export const testConfig: AgentConfig = {
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
  model: {
    provider: 'openai',
    name: 'gpt-4o',
    api_key: 'model-key',
    base_url: null,
    max_output_tokens: 8192,
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
