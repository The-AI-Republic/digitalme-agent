import { JAILBREAK_PATTERNS, PII_PATTERNS } from './patterns.js';
import type { GuardrailConfig, InputScreenResult } from './types.js';

const PASS: InputScreenResult = { safe: true, action: 'proceed' };

/**
 * Screens fan input before the model call.
 * Pure function — no LLM calls, regex/substring only.
 * Check order: jailbreak -> PII -> blocked keywords (exit on first block).
 */
export function screenInput(message: string, config: GuardrailConfig): InputScreenResult {
  if (!config.enabled) return PASS;

  // 1. Jailbreak detection
  if (config.jailbreak_detection.enabled) {
    for (const pattern of JAILBREAK_PATTERNS) {
      if (pattern.regex.test(message)) {
        return {
          safe: false,
          category: 'jailbreak',
          action: 'block',
          matchedRule: pattern.name,
        };
      }
    }
  }

  // 2. PII detection
  if (config.pii_detection.enabled && config.pii_detection.block_in_input) {
    for (const pattern of PII_PATTERNS) {
      if (pattern.regex.test(message)) {
        return {
          safe: false,
          category: 'pii',
          action: 'block',
          matchedRule: pattern.name,
        };
      }
    }
  }

  // 3. Blocked keywords (case-insensitive, word-boundary match)
  if (config.blocked_keywords.length > 0) {
    for (const keyword of config.blocked_keywords) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
      if (pattern.test(message)) {
        return {
          safe: false,
          category: 'blocked_keyword',
          action: 'block',
          matchedRule: keyword,
        };
      }
    }
  }

  return PASS;
}
