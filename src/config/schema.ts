import { z } from 'zod';

export const historyMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(100_000),
});

export const agentConfigSchema = z.object({
  persona: z.object({
    name: z.string().min(1),
    default_system_prompt: z.string().min(1),
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
  model: z.object({
    provider: z.enum([
      'openai',
      'xai',
      'groq',
      'google-ai-studio',
      'fireworks',
      'together',
    ]),
    name: z.string().min(1),
    api_key: z.string().min(1),
    base_url: z.string().optional().nullable(),
  }),
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
  guardrails: z.object({
    enabled: z.boolean().default(false),
    blocked_keywords: z.array(z.string().trim().min(1)).default([]),
    response_rules: z.object({
      max_response_length: z.number().int().positive().default(2000),
      block_external_links: z.boolean().default(false),
    }).default({}),
    pii_detection: z.object({
      enabled: z.boolean().default(false),
      block_in_input: z.boolean().default(true),
      block_in_output: z.boolean().default(true),
    }).default({}),
    jailbreak_detection: z.object({
      enabled: z.boolean().default(false),
    }).default({}),
    messages: z.object({
      input_blocked: z.string().default(
        "I can't respond to that. Let me know if there's something else I can help with!",
      ),
      output_blocked: z.string().default(
        'Sorry, I wasn\'t able to generate a suitable response. Please try again.',
      ),
    }).default({}),
  }).default({}),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
