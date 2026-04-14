import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoadedSkill } from './types.js';
import { validateSkill } from './SkillValidator.js';

function makeSkill(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    name: 'beat-catalog',
    description: 'Search my beat catalog',
    when_to_use: 'When fan asks about beats or pricing',
    allowed_tools: [],
    context: 'inline',
    model: 'inherit',
    max_turns: 1,
    timeout_seconds: 30,
    prompt: 'This is a sufficiently long prompt body.',
    supporting_context: [],
    source_dir: '/tmp/beat-catalog',
    source: 'bundled',
    ...overrides,
  };
}

test('validateSkill accepts a valid skill', () => {
  const result = validateSkill(makeSkill());
  assert.equal(result.valid, true);
});

test('validateSkill rejects invalid names and oversize prompts', () => {
  const result = validateSkill(makeSkill({
    name: 'Bad_Name',
    prompt: 'x'.repeat(6000),
  }));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Invalid skill name')));
  assert.ok(result.errors.some((error) => error.includes('prompt exceeds max length')));
});

test('validateSkill rejects invalid turn and timeout bounds', () => {
  const result = validateSkill(makeSkill({
    max_turns: 0,
    timeout_seconds: 121,
  }));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('max-turns')));
  assert.ok(result.errors.some((error) => error.includes('timeout-seconds')));
});
