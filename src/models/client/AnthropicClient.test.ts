import test from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicClient } from './AnthropicClient.js';

function makeClient() {
  return new AnthropicClient({
    apiKey: 'test-key',
    model: 'claude-sonnet-4-20250514',
  });
}

test('AnthropicClient sets cache_control on stable blocks', () => {
  const client = makeClient();
  const blocks = client.buildSystemBlocks({
    model: 'claude-sonnet-4-20250514',
    messages: [],
    systemPromptBlocks: [
      { text: 'stable content', cachePolicy: 'stable' },
      { text: 'volatile content', cachePolicy: 'volatile' },
    ],
  });

  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    type: 'text',
    text: 'stable content',
    cache_control: { type: 'ephemeral' },
  });
  assert.deepEqual(blocks[1], {
    type: 'text',
    text: 'volatile content',
  });
});

test('AnthropicClient falls back to system messages when no blocks provided', () => {
  const client = makeClient();
  const blocks = client.buildSystemBlocks({
    model: 'claude-sonnet-4-20250514',
    messages: [
      { role: 'system', content: 'system prompt here' },
      { role: 'user', content: 'hi' },
    ],
  });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.text, 'system prompt here');
  assert.equal(blocks[0]!.cache_control, undefined);
});

test('AnthropicClient returns empty array when no system content', () => {
  const client = makeClient();
  const blocks = client.buildSystemBlocks({
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(blocks.length, 0);
});

test('AnthropicClient filters system messages from conversation messages', () => {
  const client = makeClient();
  const messages = client.buildMessages([
    { role: 'system', content: 'should be filtered' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);

  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, 'user');
  assert.equal(messages[1]!.role, 'assistant');
});

test('AnthropicClient converts tool results to user messages with tool_result blocks', () => {
  const client = makeClient();
  const messages = client.buildMessages([
    { role: 'user', content: 'search for cats' },
    { role: 'assistant', content: null, toolCalls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'web_search', arguments: '{"q":"cats"}' },
    }] },
    { role: 'tool', content: 'cats are great', toolCallId: 'call_1', toolName: 'web_search' },
  ]);

  assert.equal(messages.length, 3);
  assert.equal(messages[2]!.role, 'user');
  assert.ok(Array.isArray(messages[2]!.content));
  const block = (messages[2]!.content as any[])[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.tool_use_id, 'call_1');
});

test('AnthropicClient converts assistant tool_use messages correctly', () => {
  const client = makeClient();
  const messages = client.buildMessages([
    { role: 'user', content: 'do something' },
    { role: 'assistant', content: 'I will search', toolCalls: [{
      id: 'call_2',
      type: 'function',
      function: { name: 'web_search', arguments: '{"q":"test"}' },
    }] },
  ]);

  assert.equal(messages.length, 2);
  assert.equal(messages[1]!.role, 'assistant');
  const content = messages[1]!.content as any[];
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, 'I will search');
  assert.equal(content[1].type, 'tool_use');
  assert.equal(content[1].id, 'call_2');
  assert.equal(content[1].name, 'web_search');
});
