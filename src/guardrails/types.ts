import type { AgentConfig } from '../config/schema.js';

export type GuardrailConfig = AgentConfig['guardrails'];

export interface InputScreenResult {
  safe: boolean;
  category?: 'jailbreak' | 'pii' | 'blocked_keyword' | 'error';
  action: 'proceed' | 'block';
  matchedRule?: string;
}

export type ViolationSeverity = 'critical' | 'medium' | 'low';

export interface Violation {
  rule: string;
  severity: ViolationSeverity;
  category: 'blocked_keyword' | 'pii' | 'external_link' | 'length';
}

export interface OutputValidationResult {
  violations: Violation[];
  action: 'send' | 'block' | 'modify';
  modifiedText?: string;
  replacementResponse?: string;
}
