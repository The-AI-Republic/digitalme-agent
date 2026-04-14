import { PII_PATTERNS, EXTERNAL_LINK_PATTERN } from './patterns.js';
import type { GuardrailConfig, OutputValidationResult, Violation } from './types.js';

const PASS: OutputValidationResult = { violations: [], action: 'send' };

/**
 * Validates agent output before delivery to the fan.
 * Pure function — no LLM calls, regex/substring only.
 * Check order: blocked keywords -> PII -> external links -> length.
 */
export function validateOutput(text: string, config: GuardrailConfig): OutputValidationResult {
  if (!config.enabled) return PASS;

  const violations: Violation[] = [];

  // 1. Blocked keywords — critical
  if (config.blocked_keywords.length > 0) {
    const lower = text.toLowerCase();
    for (const keyword of config.blocked_keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        violations.push({
          rule: keyword,
          severity: 'critical',
          category: 'blocked_keyword',
        });
      }
    }
  }

  // 2. PII detection — critical
  if (config.pii_detection.enabled && config.pii_detection.block_in_output) {
    for (const pattern of PII_PATTERNS) {
      if (pattern.regex.test(text)) {
        violations.push({
          rule: pattern.name,
          severity: 'critical',
          category: 'pii',
        });
      }
    }
  }

  // 3. External links — medium
  if (config.response_rules.block_external_links) {
    if (EXTERNAL_LINK_PATTERN.regex.test(text)) {
      violations.push({
        rule: 'external_link',
        severity: 'medium',
        category: 'external_link',
      });
    }
  }

  // 4. Response length — low
  if (text.length > config.response_rules.max_response_length) {
    violations.push({
      rule: `max_length_${config.response_rules.max_response_length}`,
      severity: 'low',
      category: 'length',
    });
  }

  if (violations.length === 0) return PASS;

  // Determine action based on highest severity
  const hasCritical = violations.some((v) => v.severity === 'critical');
  if (hasCritical) {
    return {
      violations,
      action: 'block',
      replacementResponse: config.messages.output_blocked,
    };
  }

  // Medium or low — modify the text
  let modified = text;

  // Strip external links
  if (violations.some((v) => v.category === 'external_link')) {
    modified = modified.replace(/https?:\/\/[^\s]+/gi, '[link removed]');
  }

  // Truncate if too long
  const maxLen = config.response_rules.max_response_length;
  if (modified.length > maxLen) {
    modified = modified.slice(0, maxLen - 3) + '...';
  }

  return {
    violations,
    action: 'modify',
    modifiedText: modified,
  };
}
