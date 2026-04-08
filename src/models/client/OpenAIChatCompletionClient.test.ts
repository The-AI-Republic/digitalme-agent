import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIChatCompletionClient } from './OpenAIChatCompletionClient.js';

test('constructor sets default OpenAI base URL', () => {
  const client = new OpenAIChatCompletionClient({
    apiKey: 'test-key',
    model: 'gpt-4o',
  });

  // Access private field to verify default base URL
  assert.equal((client as any).baseUrl, 'https://api.openai.com/v1');
});

test('constructor uses custom base URL when provided', () => {
  const client = new OpenAIChatCompletionClient({
    apiKey: 'test-key',
    model: 'gpt-4o',
    baseUrl: 'https://custom.api/v1',
  });

  assert.equal((client as any).baseUrl, 'https://custom.api/v1');
});

test('constructor stores model and apiKey', () => {
  const client = new OpenAIChatCompletionClient({
    apiKey: 'my-api-key',
    model: 'gpt-4o-mini',
  });

  assert.equal((client as any).model, 'gpt-4o-mini');
  assert.equal((client as any).apiKey, 'my-api-key');
});
