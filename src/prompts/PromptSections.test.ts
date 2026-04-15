import test from 'node:test';
import assert from 'node:assert/strict';

import { PROMPT_SECTIONS } from './PromptSections.js';
import type { PromptContext } from './types.js';

function makeContext(overrides?: Partial<PromptContext>): PromptContext {
  return {
    soulName: 'TestBot',
    soulDescription: 'A test bot for testing.',
    soulTone: null,
    soulBoundaries: null,
    soulKnowledge: null,
    soulOthers: null,
    approvedToolNames: [],
    skillListing: null,
    modelName: 'gpt-4o',
    providerName: 'openai',
    ...overrides,
  };
}

test('PROMPT_SECTIONS is a non-empty array', () => {
  assert.ok(Array.isArray(PROMPT_SECTIONS));
  assert.ok(PROMPT_SECTIONS.length > 0);
});

test('all sections have required fields', () => {
  for (const section of PROMPT_SECTIONS) {
    assert.ok(section.name, `section missing name`);
    assert.ok(['stable', 'volatile'].includes(section.cachePolicy), `invalid cachePolicy: ${section.cachePolicy}`);
    assert.ok(['static', 'dynamic'].includes(section.boundary), `invalid boundary: ${section.boundary}`);
    assert.ok(typeof section.buildTemplateVars === 'function', `buildTemplateVars must be function`);
  }
});

test('section names are unique', () => {
  const names = PROMPT_SECTIONS.map((s) => s.name);
  const unique = new Set(names);
  assert.equal(unique.size, names.length, 'Duplicate section names found');
});

test('base_system section exists and is static/stable', () => {
  const base = PROMPT_SECTIONS.find((s) => s.name === 'base_system');
  assert.ok(base);
  assert.equal(base.cachePolicy, 'stable');
  assert.equal(base.boundary, 'static');
});

test('security section exists and is static/stable', () => {
  const sec = PROMPT_SECTIONS.find((s) => s.name === 'security');
  assert.ok(sec);
  assert.equal(sec.cachePolicy, 'stable');
  assert.equal(sec.boundary, 'static');
});

test('soul section builds template vars from context', () => {
  const soul = PROMPT_SECTIONS.find((s) => s.name === 'soul')!;
  const ctx = makeContext({
    soulName: 'Aria',
    soulDescription: 'A creative soul.',
    soulTone: 'Friendly and warm.',
    soulBoundaries: 'No politics.',
    soulKnowledge: 'Knows music.',
    soulOthers: 'Extra info.',
  });

  const vars = soul.buildTemplateVars(ctx);
  assert.equal(vars.soulName, 'Aria');
  assert.ok(vars.soulBody.includes('A creative soul.'));
  assert.ok(vars.soulBody.includes('Friendly and warm.'));
  assert.ok(vars.soulBody.includes('No politics.'));
  assert.ok(vars.soulBody.includes('Knows music.'));
  assert.ok(vars.soulBody.includes('Extra info.'));
});

test('soul section omits null optional fields', () => {
  const soul = PROMPT_SECTIONS.find((s) => s.name === 'soul')!;
  const ctx = makeContext({ soulDescription: 'Core description only.' });

  const vars = soul.buildTemplateVars(ctx);
  assert.equal(vars.soulBody, 'Core description only.');
});

test('tool_policy section lists approved tools', () => {
  const tp = PROMPT_SECTIONS.find((s) => s.name === 'tool_policy')!;
  const ctx = makeContext({ approvedToolNames: ['web_search', 'code_run'] });

  const vars = tp.buildTemplateVars(ctx);
  assert.ok(vars.toolPolicySummary.includes('web_search'));
  assert.ok(vars.toolPolicySummary.includes('code_run'));
});

test('tool_policy section shows no-tools message when empty', () => {
  const tp = PROMPT_SECTIONS.find((s) => s.name === 'tool_policy')!;
  const ctx = makeContext({ approvedToolNames: [] });

  const vars = tp.buildTemplateVars(ctx);
  assert.ok(vars.toolPolicySummary.includes('No tools'));
});

test('skills section is enabled only when skillListing is present', () => {
  const skills = PROMPT_SECTIONS.find((s) => s.name === 'skills')!;
  assert.ok(skills.enabledWhen);

  assert.equal(skills.enabledWhen(makeContext({ skillListing: null })), false);
  assert.equal(skills.enabledWhen(makeContext({ skillListing: '' })), false);
  assert.equal(skills.enabledWhen(makeContext({ skillListing: 'skill1: does stuff' })), true);
});

test('skills section passes skillListing through as template var', () => {
  const skills = PROMPT_SECTIONS.find((s) => s.name === 'skills')!;
  const ctx = makeContext({ skillListing: '- greet: says hello' });

  const vars = skills.buildTemplateVars(ctx);
  assert.equal(vars.skillListing, '- greet: says hello');
});

test('static sections appear before dynamic sections', () => {
  const boundaries = PROMPT_SECTIONS.map((s) => s.boundary);
  const lastStaticIndex = boundaries.lastIndexOf('static');
  const firstDynamicIndex = boundaries.indexOf('dynamic');

  if (lastStaticIndex >= 0 && firstDynamicIndex >= 0) {
    assert.ok(lastStaticIndex < firstDynamicIndex, 'Static sections should come before dynamic sections');
  }
});
