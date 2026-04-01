import assert from 'node:assert/strict';
import test from 'node:test';
import { PromptComposer } from './PromptComposer.js';
import { testConfig } from '../test/fixtures.js';
import type { Message } from '../models/ModelClient.js';

test('compose creates system prompt with tool policy and appends user message', () => {
  const composer = new PromptComposer(testConfig, []);
  const messages = composer.compose([], 'hello');

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content?.includes(testConfig.persona.default_system_prompt));
  assert.ok(messages[0].content?.includes('Approved tools: none.'));
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content, 'hello');
});

test('compose includes tool names when provided', () => {
  const composer = new PromptComposer(testConfig, ['web_search', 'calculator']);
  const messages = composer.compose([], 'query');

  assert.ok(messages[0].content?.includes('Approved tools: web_search, calculator.'));
});

test('compose includes history between system and user messages', () => {
  const composer = new PromptComposer(testConfig, []);
  const history: Message[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'response' },
  ];
  const messages = composer.compose(history, 'follow-up');

  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content, 'first');
  assert.equal(messages[2].role, 'assistant');
  assert.equal(messages[2].content, 'response');
  assert.equal(messages[3].role, 'user');
  assert.equal(messages[3].content, 'follow-up');
});
