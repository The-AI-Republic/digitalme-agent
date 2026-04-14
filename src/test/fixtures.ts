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
  skills: {
    bundled_dir: './skills',
    local_dir: '/app/skills-local',
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
  context: {
    model_metadata: {
      'gpt-4o': { context_window_size: 128000, max_output_tokens: 16384 },
    },
    default_context_window_size: 128000,
    default_max_output_tokens: 4096,
    microcompact: {
      enabled: true,
      gap_threshold_minutes: 60,
      keep_recent_results: 5,
    },
    tool_result_persistence: {
      enabled: true,
      default_max_result_chars: 10000,
      per_message_budget_chars: 30000,
      preview_size_bytes: 2000,
      storage_dir: '/tmp/digitalme-agent-test',
    },
    session_memory: {
      enabled: false,
      extraction_model: null,
      tokens_between_updates: 5000,
      tool_calls_between_updates: 3,
      minimum_tokens_to_init: 10000,
      max_total_tokens: 8000,
      max_section_tokens: 1500,
    },
    summary: {
      enabled: true,
      model: null,
      max_summary_tokens: 2000,
      preserve_recent_messages: 10,
    },
    thresholds: {
      microcompact_ratio: 0.5,
      projection_ratio: 0.7,
      overflow_ratio: 0.9,
      safety_margin: 1.33,
    },
    reactive_compact: {
      max_retries: 1,
      aggressive_preserve_messages: 3,
    },
    max_output_recovery: {
      max_retries: 2,
    },
  },
  quotas: {
    enabled: false,
    on_quota_exceeded: 'graceful_refuse',
    quota_warning_threshold: 0.8,
  },
  routing: {
    task_models: {},
    health: {
      enabled: true,
      window_size: 20,
      failure_threshold: 0.5,
      recovery_after_seconds: 60,
    },
  },
  forked_agents: {
    enabled: true,
    max_concurrent: 2,
  },
  hooks: {
    post_turn: {
      enabled: true,
      timeout_ms: 30000,
    },
  },
  guardrails: {
    enabled: false,
    blocked_keywords: [],
    response_rules: {
      max_response_length: 2000,
      block_external_links: false,
    },
    pii_detection: {
      enabled: false,
      block_in_input: true,
      block_in_output: true,
    },
    jailbreak_detection: {
      enabled: false,
    },
    messages: {
      input_blocked: "I can't respond to that. Let me know if there's something else I can help with!",
      output_blocked: "Sorry, I wasn't able to generate a suitable response. Please try again.",
    },
  },
};
