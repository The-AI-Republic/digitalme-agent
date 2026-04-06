import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SystemPromptBuilder } from './SystemPromptBuilder.js';
import { TemplateLoader } from './TemplateLoader.js';
import type { PromptContext } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesPath = join(__dirname, 'templates');

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    creatorName: 'Test Creator',
    creatorDefaultSystemPrompt: 'You are a helpful test agent.',
    approvedToolNames: ['web_search'],
    modelName: 'gpt-4o',
    providerName: 'openai',
    ...overrides,
  };
}

function makeBuilder() {
  const loader = new TemplateLoader(templatesPath);
  return new SystemPromptBuilder(loader);
}

test('SystemPromptBuilder produces 4 sections in correct order', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  assert.equal(result.sections.length, 4);
  assert.deepEqual(
    result.sections.map((s) => s.name),
    ['base_system', 'tone_style', 'creator_persona', 'tool_policy'],
  );
});

test('staticPrefix contains base_system and tone_style content', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  assert.equal(result.staticPrefix.length, 2);
  assert.ok(result.staticPrefix[0]!.includes('Agent Operating Rules'));
  assert.ok(result.staticPrefix[1]!.includes('Response Style'));
});

test('dynamicTail contains creator_persona and tool_policy content', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  assert.equal(result.dynamicTail.length, 2);
  assert.ok(result.dynamicTail[0]!.includes('Test Creator'));
  assert.ok(result.dynamicTail[0]!.includes('You are a helpful test agent.'));
  assert.ok(result.dynamicTail[1]!.includes('Approved tools: web_search.'));
});

test('finalSystemPrompt equals [...staticPrefix, ...dynamicTail]', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  assert.deepEqual(result.finalSystemPrompt, [
    ...result.staticPrefix,
    ...result.dynamicTail,
  ]);
});

test('creatorSystemPromptOverride replaces all sections', () => {
  const builder = makeBuilder();
  const result = builder.build(
    makeContext({ creatorSystemPromptOverride: 'Custom override prompt.' }),
  );

  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0]!.name, 'override');
  assert.equal(result.sections[0]!.content, 'Custom override prompt.');
  assert.deepEqual(result.finalSystemPrompt, ['Custom override prompt.']);
});

test('creatorSystemPromptAppend adds a final creator_append section', () => {
  const builder = makeBuilder();
  const result = builder.build(
    makeContext({ creatorSystemPromptAppend: 'Extra instructions.' }),
  );

  assert.equal(result.sections.length, 5);
  assert.equal(result.sections[4]!.name, 'creator_append');
  assert.equal(result.sections[4]!.content, 'Extra instructions.');
  assert.equal(result.sections[4]!.boundary, 'dynamic');
});

test('override wins over append — append is ignored when override is set', () => {
  const builder = makeBuilder();
  const result = builder.build(
    makeContext({
      creatorSystemPromptOverride: 'Override only.',
      creatorSystemPromptAppend: 'Should be ignored.',
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

  // The 4 core sections should maintain declaration order
  const names = result.sections.map((s) => s.name);
  assert.ok(names.indexOf('base_system') < names.indexOf('tone_style'));
  assert.ok(names.indexOf('tone_style') < names.indexOf('creator_persona'));
  assert.ok(names.indexOf('creator_persona') < names.indexOf('tool_policy'));
});

test('sections have correct boundary assignments', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  const byName = Object.fromEntries(result.sections.map((s) => [s.name, s]));
  assert.equal(byName['base_system']!.boundary, 'static');
  assert.equal(byName['tone_style']!.boundary, 'static');
  assert.equal(byName['creator_persona']!.boundary, 'dynamic');
  assert.equal(byName['tool_policy']!.boundary, 'dynamic');
});

test('sections have correct cachePolicy assignments', () => {
  const builder = makeBuilder();
  const result = builder.build(makeContext());

  const byName = Object.fromEntries(result.sections.map((s) => [s.name, s]));
  assert.equal(byName['base_system']!.cachePolicy, 'stable');
  assert.equal(byName['tone_style']!.cachePolicy, 'stable');
  assert.equal(byName['creator_persona']!.cachePolicy, 'volatile');
  assert.equal(byName['tool_policy']!.cachePolicy, 'volatile');
});
