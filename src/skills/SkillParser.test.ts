import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSkillFile, toLoadedSkill } from './SkillParser.js';

test('parseSkillFile parses YAML frontmatter and markdown body', () => {
  const parsed = parseSkillFile(`---
name: beat-catalog
description: Search beats
when_to_use: When fans ask about beats
allowed-tools: [web_search]
context: fork
model: gpt-4o-mini
max-turns: 2
timeout-seconds: 15
argument-hint: beat query
---

Prompt body
`);

  assert.equal(parsed.frontmatter['name'], 'beat-catalog');
  assert.equal(parsed.body, 'Prompt body');
});

test('toLoadedSkill applies defaults when frontmatter fields are omitted', () => {
  const skill = toLoadedSkill(
    { frontmatter: { description: 'Desc', when_to_use: 'When fan asks about beats' }, body: 'Prompt body long enough' },
    'skill-dir',
    '/tmp/skill-dir',
    'bundled',
  );

  assert.equal(skill.name, 'skill-dir');
  assert.equal(skill.context, 'inline');
  assert.equal(skill.model, 'inherit');
  assert.equal(skill.max_turns, 3);
  assert.equal(skill.timeout_seconds, 30);
  assert.equal(skill.source, 'bundled');
});

test('parseSkillFile returns empty frontmatter when no fence is present', () => {
  const parsed = parseSkillFile('Plain prompt body');
  assert.deepEqual(parsed.frontmatter, {});
  assert.equal(parsed.body, 'Plain prompt body');
});
