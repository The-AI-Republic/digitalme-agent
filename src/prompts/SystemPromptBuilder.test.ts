import test from 'node:test';
import assert from 'node:assert/strict';

import { SystemPromptBuilder } from './SystemPromptBuilder.js';
import { TemplateLoader } from './TemplateLoader.js';
import type { PromptContext } from './types.js';

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    soulName: 'Test Creator',
    soulDescription: 'You are a helpful test agent.',
    approvedToolNames: ['web_search'],
    modelName: 'gpt-4o',
    providerName: 'openai',
    ...overrides,
  };
}

function makeBuilder() {
  return new SystemPromptBuilder(new TemplateLoader());
}

test('SystemPromptBuilder produces 5 sections in correct order', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  assert.equal(result.sections.length, 5);
  assert.deepEqual(
    result.sections.map((s) => s.name),
    ['base_system', 'security', 'tone_style', 'soul', 'tool_policy'],
  );
});

test('staticPrefix contains base_system, security, and tone_style content', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  assert.equal(result.staticPrefix.length, 3);
  assert.ok(result.staticPrefix[0]!.includes('Agent Operating Rules'));
  assert.ok(result.staticPrefix[1]!.includes('Security Policy'));
  assert.ok(result.staticPrefix[2]!.includes('Response Style'));
});

test('dynamicTail contains soul and tool_policy content', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  assert.equal(result.dynamicTail.length, 2);
  assert.ok(result.dynamicTail[0]!.includes('Test Creator'));
  assert.ok(result.dynamicTail[0]!.includes('You are a helpful test agent.'));
  assert.ok(result.dynamicTail[1]!.includes('Approved tools: web_search.'));
});

test('finalSystemPrompt preserves section declaration order', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  assert.deepEqual(
    result.finalSystemPrompt,
    result.sections.map((s) => s.content),
  );
});

test('soulSystemPromptOverride replaces all sections', () => {
  const builder = makeBuilder();
  const result = builder.build(
    makeContext({ soulSystemPromptOverride: 'Custom override prompt.' }),
  );

  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0]!.name, 'override');
  assert.equal(result.sections[0]!.content, 'Custom override prompt.');
  assert.deepEqual(result.finalSystemPrompt, ['Custom override prompt.']);
});

test('soulSystemPromptAppend adds a final soul_append section', () => {
  const builder = makeBuilder();
  const result = builder.build(
    makeContext({ soulSystemPromptAppend: 'Extra instructions.' }),
  );

  assert.equal(result.sections.length, 6);
  assert.equal(result.sections[5]!.name, 'soul_append');
  assert.equal(result.sections[5]!.content, 'Extra instructions.');
  assert.equal(result.sections[5]!.boundary, 'dynamic');
});

test('override wins over append — append is ignored when override is set', () => {
  const builder = makeBuilder();
  const result = builder.build(
    makeContext({
      soulSystemPromptOverride: 'Override only.',
      soulSystemPromptAppend: 'Should be ignored.',
    }),
  );

  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0]!.name, 'override');
  assert.ok(!result.finalSystemPrompt.join('').includes('Should be ignored'));
});

test('empty approvedToolNames renders no-tools message', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext({ approvedToolNames: [] }));

  const toolSection = result.sections.find((s) => s.name === 'tool_policy');
  assert.ok(toolSection);
  assert.ok(toolSection.content.includes('No tools are currently available.'));
});

test('section names are stable across calls with same context', () => {
  const builder = makeBuilder();
  const ctx = makeContext();
  const first = builder.build(ctx);
  const second = builder.build(ctx);

  assert.deepEqual(
    first.sections.map((s) => s.name),
    second.sections.map((s) => s.name),
  );
});

test('section ordering matches PROMPT_SECTIONS declaration order', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  const names = result.sections.map((s) => s.name);
  assert.ok(names.indexOf('base_system') < names.indexOf('security'));
  assert.ok(names.indexOf('security') < names.indexOf('tone_style'));
  assert.ok(names.indexOf('tone_style') < names.indexOf('soul'));
  assert.ok(names.indexOf('soul') < names.indexOf('tool_policy'));
});

test('sections have correct boundary assignments', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  const byName = Object.fromEntries(result.sections.map((s) => [s.name, s]));
  assert.equal(byName['base_system']!.boundary, 'static');
  assert.equal(byName['security']!.boundary, 'static');
  assert.equal(byName['tone_style']!.boundary, 'static');
  assert.equal(byName['soul']!.boundary, 'dynamic');
  assert.equal(byName['tool_policy']!.boundary, 'dynamic');
});

test('sections have correct cachePolicy assignments', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  const byName = Object.fromEntries(result.sections.map((s) => [s.name, s]));
  assert.equal(byName['base_system']!.cachePolicy, 'stable');
  assert.equal(byName['security']!.cachePolicy, 'stable');
  assert.equal(byName['tone_style']!.cachePolicy, 'stable');
  assert.equal(byName['soul']!.cachePolicy, 'volatile');
  assert.equal(byName['tool_policy']!.cachePolicy, 'volatile');
});

test('stable sections return same content reference across builds', () => {
  const builder = makeBuilder();
  const first = builder.build(makeContext());
  const second = builder.build(makeContext());

  const firstBase = first.sections.find((s) => s.name === 'base_system')!;
  const secondBase = second.sections.find((s) => s.name === 'base_system')!;
  assert.equal(firstBase, secondBase, 'stable section should return cached object');
});

test('volatile sections are recomputed across builds', () => {
  const builder = makeBuilder();
  const first = builder.build(makeContext());
  const second = builder.build(makeContext());

  const firstTool = first.sections.find((s) => s.name === 'tool_policy')!;
  const secondTool = second.sections.find((s) => s.name === 'tool_policy')!;
  assert.notEqual(firstTool, secondTool, 'volatile section should be a new object');
  assert.equal(firstTool.content, secondTool.content);
});

test('clearCache causes stable sections to recompute', () => {
  const builder = makeBuilder();
  const first = builder.build(makeContext());
  const firstBase = first.sections.find((s) => s.name === 'base_system')!;

  builder.clearCache();

  const second = builder.build(makeContext());
  const secondBase = second.sections.find((s) => s.name === 'base_system')!;
  assert.notEqual(firstBase, secondBase, 'should be a new object after clearCache');
  assert.equal(firstBase.content, secondBase.content);
});
