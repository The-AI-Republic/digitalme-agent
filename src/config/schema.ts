import { z } from 'zod';

export const historyMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(100_000),
});

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
  model: z.object({
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
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
