import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TemplateLoader } from './TemplateLoader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesPath = join(__dirname, 'templates');

test('TemplateLoader loads a known template', () => {
  const loader = new TemplateLoader(templatesPath);
  const content = loader.get('base_system');
  assert.ok(content.includes('Agent Operating Rules'));
});

test('TemplateLoader throws on unknown template', () => {
  const loader = new TemplateLoader(templatesPath);
  assert.throws(() => loader.get('nonexistent'), /Unknown prompt template: nonexistent/);
});

test('TemplateLoader caches templates (same reference)', () => {
  const loader = new TemplateLoader(templatesPath);
  const first = loader.get('base_system');
  const second = loader.get('base_system');
  assert.equal(first, second);
});

test('TemplateLoader.renderTemplate replaces {{var}} placeholders', () => {
  const loader = new TemplateLoader(templatesPath);
  const result = loader.renderTemplate('Hello {{name}}, you are {{role}}.', {
    name: 'Alice',
    role: 'admin',
  });
  assert.equal(result, 'Hello Alice, you are admin.');
});

test('TemplateLoader.renderTemplate replaces missing vars with empty string', () => {
  const loader = new TemplateLoader(templatesPath);
  const result = loader.renderTemplate('Hello {{name}}, your id is {{id}}.', {
    name: 'Bob',
  });
  assert.equal(result, 'Hello Bob, your id is .');
});

test('TemplateLoader.renderTemplate handles template with no placeholders', () => {
  const loader = new TemplateLoader(templatesPath);
  const result = loader.renderTemplate('No variables here.', { unused: 'value' });
  assert.equal(result, 'No variables here.');
});

test('TemplateLoader loads all 4 initial templates', () => {
  const loader = new TemplateLoader(templatesPath);
  assert.ok(loader.get('base_system'));
  assert.ok(loader.get('tone_style'));
  assert.ok(loader.get('creator_persona'));
  assert.ok(loader.get('tool_policy'));
});
