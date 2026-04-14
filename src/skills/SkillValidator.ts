import type { LoadedSkill, ValidationResult } from './types.js';
import { SKILL_LIMITS } from './types.js';

export function validateSkill(skill: LoadedSkill): ValidationResult {
  const errors: string[] = [];

  if (!/^[a-z][a-z0-9-]*$/.test(skill.name)) {
    errors.push(`Invalid skill name: ${skill.name}`);
  }
  if (!skill.description || skill.description.length > 200) {
    errors.push('description required, max 200 chars');
  }
  if (!skill.when_to_use || skill.when_to_use.length < 10) {
    errors.push('when_to_use required (min 10 chars)');
  }
  if (!skill.prompt || skill.prompt.length < 20) {
    errors.push('prompt required (min 20 chars)');
  }
  if (skill.max_turns < 1 || skill.max_turns > 10) {
    errors.push('max-turns must be between 1 and 10');
  }
  if (skill.timeout_seconds < 1 || skill.timeout_seconds > 120) {
    errors.push('timeout-seconds must be between 1 and 120');
  }
  if (skill.context !== 'inline' && skill.context !== 'fork') {
    errors.push(`invalid context: ${skill.context}`);
  }
  if (skill.model.length === 0) {
    errors.push('model cannot be empty');
  }

  const totalPromptLength = [
    skill.prompt,
    ...skill.supporting_context,
  ].join('\n\n').length;
  if (totalPromptLength > SKILL_LIMITS.maxPromptLength) {
    errors.push(`prompt exceeds max length of ${SKILL_LIMITS.maxPromptLength}`);
  }

  return { valid: errors.length === 0, errors };
}
