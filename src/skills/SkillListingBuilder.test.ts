import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSkillListingSection } from './SkillListingBuilder.js';
import type { LoadedSkill } from './types.js';

function makeSkill(name: string, description = 'Search the creator catalog'): LoadedSkill {
  return {
    name,
    description,
    when_to_use: 'When fan asks about pricing, products, or availability',
    allowed_tools: [],
    context: 'inline',
    model: 'inherit',
    max_turns: 1,
    timeout_seconds: 30,
    prompt: 'This prompt body is definitely long enough.',
    supporting_context: [],
    source_dir: `/tmp/${name}`,
    source: 'bundled',
  };
}

test('buildSkillListingSection returns empty string for no skills', () => {
  assert.equal(buildSkillListingSection([]), '');
});

test('buildSkillListingSection includes invocation instructions', () => {
  const listing = buildSkillListingSection([makeSkill('beat-catalog')]);
  assert.ok(listing.includes('Available skills:'));
  assert.ok(listing.includes('Use the CreatorSkill tool'));
  assert.ok(listing.includes('- beat-catalog:'));
});

test('buildSkillListingSection truncates to budget and adds omitted marker', () => {
  const skills = Array.from({ length: 20 }, (_, index) =>
    makeSkill(`skill-${index}`, 'x'.repeat(220)));

  const listing = buildSkillListingSection(skills);
  assert.ok(listing.length <= 1700);
  assert.ok(listing.includes('additional skills omitted'));
});
