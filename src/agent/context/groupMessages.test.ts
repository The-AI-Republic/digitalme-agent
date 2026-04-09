import test from 'node:test';
import assert from 'node:assert/strict';

import { groupMessages } from './groupMessages.js';
import type { Message } from '../../models/ModelClient.js';

test('groups plain user and assistant messages as single-message groups', () => {
  const messages: Message[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'bye' },
  ];
  const groups = groupMessages(messages);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.messageCount), [1, 1, 1]);
  assert.deepEqual(groups.map((g) => g.startIndex), [0, 1, 2]);
});

test('groups assistant with toolCalls plus matching tool results', () => {
  const messages: Message[] = [
    { role: 'user', content: 'search for cats' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"cats"}' } },
        { id: 'call_2', type: 'function', function: { name: 'web_search', arguments: '{"q":"dogs"}' } },
      ],
    },
    { role: 'tool', content: 'cats result', toolCallId: 'call_1', toolName: 'web_search' },
    { role: 'tool', content: 'dogs result', toolCallId: 'call_2', toolName: 'web_search' },
    { role: 'assistant', content: 'Here are results...' },
  ];
  const groups = groupMessages(messages);
  assert.equal(groups.length, 3);
  // First group: user message
  assert.deepEqual(groups[0], { startIndex: 0, endIndex: 0, messageCount: 1, estimatedTokens: groups[0].estimatedTokens });
  // Second group: assistant + 2 tool results
  assert.equal(groups[1].startIndex, 1);
  assert.equal(groups[1].endIndex, 3);
  assert.equal(groups[1].messageCount, 3);
  // Third group: final assistant text
  assert.equal(groups[2].startIndex, 4);
  assert.equal(groups[2].messageCount, 1);
});

test('handles empty message array', () => {
  const groups = groupMessages([]);
  assert.equal(groups.length, 0);
});

test('handles assistant with toolCalls but no following tool results', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
      ],
    },
  ];
  const groups = groupMessages(messages);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].messageCount, 1);
  assert.equal(groups[0].startIndex, 0);
  assert.equal(groups[0].endIndex, 0);
});

test('does not group tool results that belong to a different assistant message', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'call_A', type: 'function', function: { name: 'search', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: 'result A', toolCallId: 'call_A', toolName: 'search' },
    { role: 'tool', content: 'orphan', toolCallId: 'call_B', toolName: 'search' },
  ];
  const groups = groupMessages(messages);
  // Group 1: assistant + call_A tool result
  assert.equal(groups[0].startIndex, 0);
  assert.equal(groups[0].endIndex, 1);
  assert.equal(groups[0].messageCount, 2);
  // Group 2: orphaned tool result (own group)
  assert.equal(groups[1].startIndex, 2);
  assert.equal(groups[1].messageCount, 1);
});

test('system messages are their own group', () => {
  const messages: Message[] = [
    { role: 'system', content: 'You are a helpful agent.' },
    { role: 'user', content: 'hi' },
  ];
  const groups = groupMessages(messages);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].messageCount, 1);
  assert.equal(groups[1].messageCount, 1);
});
