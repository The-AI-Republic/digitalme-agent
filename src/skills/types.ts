export interface LoadedSkill {
  name: string;
  description: string;
  when_to_use: string;
  allowed_tools: string[];
  context: 'inline' | 'fork';
  model: 'inherit' | string;
  max_turns: number;
  timeout_seconds: number;
  argument_hint?: string;
  prompt: string;
  supporting_context: string[];
  source_dir: string;
  source: 'bundled' | 'local';
}

export interface SkillExecutionRecord {
  skillName: string;
  conversationId: string;
  timestamp: number;
  context: 'inline' | 'fork';
  success: boolean;
  errorReason?: string;
  latencyMs: number;
  turnsUsed: number;
  inputTokens: number;
  outputTokens: number;
  toolsUsed: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export const SKILL_LIMITS = {
  maxSkillsTotal: 20,
  maxPromptLength: 5000,
  maxListingBudget: 1500,
  maxSupportingFiles: 5,
  maxSupportingFileBytes: 50_000,
} as const;
