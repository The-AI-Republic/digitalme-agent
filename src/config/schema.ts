import { z } from 'zod';

export const historyMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(100_000),
});

export const modelSchema = z.object({
  provider: z.enum([
    'openai',
    'anthropic',
    'xai',
    'groq',
    'google-ai-studio',
    'fireworks',
    'together',
  ]),
  name: z.string().min(1),
  api_key: z.string().min(1),
  base_url: z.string().optional().nullable(),
  max_output_tokens: z.number().int().positive().default(8192),
});

export type ModelConfig = z.infer<typeof modelSchema>;

export const agentConfigSchema = z.object({
  soul: z.object({
    name: z.string().min(1),
    /** One-line description of who this agent is. */
    description: z.string().min(1),
    /** How the agent speaks — warm, blunt, formal, playful, etc. */
    tone: z.string().optional().nullable(),
    /** What the agent won't do or discuss. */
    boundaries: z.string().optional().nullable(),
    /** Domain expertise or topics the agent knows about. */
    knowledge: z.string().optional().nullable(),
    /** Any additional context the creator wants baked into the agent's soul. */
    others: z.string().optional().nullable(),
    system_prompt_override: z.string().optional().nullable(),
    system_prompt_append: z.string().optional().nullable(),
    tools: z.object({
      allow_web_search: z.boolean().default(false),
    }).default({ allow_web_search: false }),
  }),
  server: z.object({
    port: z.number().int().positive().default(8088),
    bind: z.string().default('0.0.0.0'),
  }),
  auth: z.object({
    api_key: z.string().min(1),
    signing_secret: z.string().min(1),
  }),
  platform: z.object({
    base_url: z.string().url().optional().nullable(),
    heartbeat_interval_seconds: z.number().positive().default(20),
  }).default({}),
  skills: z.object({
    bundled_dir: z.string().default('./skills'),
    local_dir: z.string().default('/app/skills-local'),
  }).default({}),
  model: modelSchema,
  fallback_model: modelSchema.optional(),
  limits: z.object({
    max_message_length: z.number().int().positive().default(4000),
    max_history_messages: z.number().int().positive().default(100),
    max_turns: z.number().int().positive().default(10),
    max_concurrent: z.number().int().positive().default(50),
    max_pending: z.number().int().positive().default(1000),
    max_active_sessions: z.number().int().positive().default(1000),
    session_ttl_seconds: z.number().int().positive().default(1800),
  }),
  security: z.object({
    hmac_tolerance_seconds: z.number().int().positive().default(300),
  }),
  context: z.object({
    model_metadata: z.record(z.object({
      context_window_size: z.number().int().positive(),
      max_output_tokens: z.number().int().positive(),
    })).default({
      'gpt-4o': { context_window_size: 128000, max_output_tokens: 16384 },
      'gpt-4o-mini': { context_window_size: 128000, max_output_tokens: 16384 },
    }),
    default_context_window_size: z.number().int().positive().default(128000),
    default_max_output_tokens: z.number().int().positive().default(4096),
    microcompact: z.object({
      enabled: z.boolean().default(true),
      gap_threshold_minutes: z.number().positive().default(60),
      keep_recent_results: z.number().int().nonnegative().default(5),
    }).default({}),
    tool_result_persistence: z.object({
      enabled: z.boolean().default(true),
      default_max_result_chars: z.number().int().positive().default(10000),
      per_message_budget_chars: z.number().int().positive().default(30000),
      preview_size_bytes: z.number().int().positive().default(2000),
      storage_dir: z.string().default('/tmp/digitalme-agent'),
    }).default({}),
    session_memory: z.object({
      enabled: z.boolean().default(false),
      extraction_model: z.string().optional().nullable(),
      tokens_between_updates: z.number().int().positive().default(5000),
      tool_calls_between_updates: z.number().int().positive().default(3),
      minimum_tokens_to_init: z.number().int().positive().default(10000),
      max_total_tokens: z.number().int().positive().default(8000),
      max_section_tokens: z.number().int().positive().default(1500),
    }).default({}),
    summary: z.object({
      enabled: z.boolean().default(true),
      model: z.string().optional().nullable(),
      max_summary_tokens: z.number().int().positive().default(2000),
      preserve_recent_messages: z.number().int().positive().default(10),
    }).default({}),
    thresholds: z.object({
      microcompact_ratio: z.number().positive().default(0.5),
      projection_ratio: z.number().positive().default(0.7),
      overflow_ratio: z.number().positive().default(0.9),
      safety_margin: z.number().positive().default(1.33),
    }).default({}),
    reactive_compact: z.object({
      max_retries: z.number().int().nonnegative().default(1),
      aggressive_preserve_messages: z.number().int().positive().default(3),
    }).default({}),
    max_output_recovery: z.object({
      max_retries: z.number().int().nonnegative().default(2),
    }).default({}),
  }).default({}),
  routing: z.object({
    task_models: z.object({
      /** Model to use for conversation summarization. Falls back to primary if omitted. */
      summary: modelSchema.optional(),
      /** Model to use for session memory extraction. Falls back to primary if omitted. */
      extraction: modelSchema.optional(),
      /** Model to use for background forked agent tasks. Falls back to primary if omitted. */
      forked: modelSchema.optional(),
    }).default({}),
    health: z.object({
      /** Enable provider health tracking and health-aware routing. */
      enabled: z.boolean().default(true),
      /** Number of recent events in the sliding window per provider. */
      window_size: z.number().int().positive().default(20),
      /** Failure rate (0–1) that trips the circuit breaker. */
      failure_threshold: z.number().positive().max(1).default(0.5),
      /** Seconds after circuit opens before allowing a probe request. */
      recovery_after_seconds: z.number().positive().default(60),
    }).default({}),
  }).default({}),
  forked_agents: z.object({
    enabled: z.boolean().default(true),
    max_concurrent: z.number().int().positive().default(2),
  }).default({}),
  hooks: z.object({
    post_turn: z.object({
      enabled: z.boolean().default(true),
      timeout_ms: z.number().int().positive().default(30000),
    }).default({}),
  }).default({}),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
