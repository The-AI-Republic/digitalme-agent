import test from 'node:test';
import assert from 'node:assert/strict';

import { groupByRound, tryReactiveCompact } from './reactiveCompact.js';
import type { Message } from '../models/ModelClient.js';

function msg(role: Message['role'], content: string | null = null, extra?: Partial<Message>): Message {
  return { role, content, ...extra } as Message;
}

// --- groupByRound ---

test('groupByRound: groups system prompt as its own group', () => {
  const messages: Message[] = [
    msg('system', 'sys'),
    msg('user', 'hello'),
    msg('assistant', 'hi'),
  ];
  const groups = groupByRound(messages);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], [msg('system', 'sys')]);
  assert.deepEqual(groups[1], [msg('user', 'hello'), msg('assistant', 'hi')]);
});

test('groupByRound: keeps assistant tool-call and tool results in same round', () => {
  const messages: Message[] = [
    msg('system', 'sys'),
    msg('user', 'q1'),
    msg('assistant', null, { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'tool', arguments: '{}' } }] }),
    msg('tool', 'result-1', { toolCallId: 'c1', toolName: 'tool' }),
    msg('user', 'q2'),
    msg('assistant', 'answer2'),
  ];
  const groups = groupByRound(messages);
  assert.equal(groups.length, 3);
  // Group 0: system
  assert.deepEqual(groups[0]!.map(m => m.role), ['system']);
  // Group 1: user1 + assistant + tool result (complete round)
  assert.deepEqual(groups[1]!.map(m => m.role), ['user', 'assistant', 'tool']);
  // Group 2: user2 + assistant
  assert.deepEqual(groups[2]!.map(m => m.role), ['user', 'assistant']);
});

test('groupByRound: handles multiple tool results in one round', () => {
  const messages: Message[] = [
    msg('system', 'sys'),
    msg('user', 'q'),
    msg('assistant', null, { toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
    ] }),
    msg('tool', 'r1', { toolCallId: 'c1' }),
    msg('tool', 'r2', { toolCallId: 'c2' }),
  ];
  const groups = groupByRound(messages);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[1]!.map(m => m.role), ['user', 'assistant', 'tool', 'tool']);
});

test('groupByRound: example from design doc', () => {
  const messages: Message[] = [
    msg('system', 'sys'),
    msg('user', 'u1'),
    msg('assistant', null, { toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] }),
    msg('tool', 'r1a', { toolCallId: 'c1' }),
    msg('user', 'u2'),
    msg('assistant', 'a2'),
    msg('user', 'u3'),
    msg('assistant', 'a3'),
  ];
  const groups = groupByRound(messages);
  assert.equal(groups.length, 4);
  // [system] [user1, assistant1, tool1] [user2, assistant2] [user3, assistant3]
  assert.deepEqual(groups[0]!.map(m => m.role), ['system']);
  assert.deepEqual(groups[1]!.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.deepEqual(groups[2]!.map(m => m.role), ['user', 'assistant']);
  assert.deepEqual(groups[3]!.map(m => m.role), ['user', 'assistant']);
});

// --- tryReactiveCompact ---

test('tryReactiveCompact: returns false when not enough groups to compact', () => {
  const messages: Message[] = [
    msg('system', 'sys'),
    msg('user', 'q1'),
    msg('assistant', 'a1'),
    msg('user', 'q2'),
    msg('assistant', 'a2'),
  ];
  // 3 groups: [system] [q1,a1] [q2,a2] — nothing to drop
  assert.equal(tryReactiveCompact(messages), false);
  assert.equal(messages.length, 5); // unchanged
});

test('tryReactiveCompact: drops middle rounds and keeps system + last 2', () => {
  const messages: Message[] = [
    msg('system', 'sys'),
    msg('user', 'q1'),
    msg('assistant', 'a1'),
    msg('user', 'q2'),
    msg('assistant', 'a2'),
    msg('user', 'q3'),
    msg('assistant', 'a3'),
    msg('user', 'q4'),
    msg('assistant', 'a4'),
  ];
  // 5 groups: [system] [q1,a1] [q2,a2] [q3,a3] [q4,a4]
  assert.equal(tryReactiveCompact(messages), true);
  // Should keep [system] + [q3,a3] + [q4,a4]
  assert.equal(messages.length, 5);
  assert.equal(messages[0]!.content, 'sys');
  assert.equal(messages[1]!.content, 'q3');
  assert.equal(messages[2]!.content, 'a3');
  assert.equal(messages[3]!.content, 'q4');
  assert.equal(messages[4]!.content, 'a4');
});

test('tryReactiveCompact: preserves tool call/result pairs during compaction', () => {
  const messages: Message[] = [
    msg('system', 'sys'),
    msg('user', 'q1'),
    msg('assistant', null, { toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] }),
    msg('tool', 'r1', { toolCallId: 'c1' }),
    msg('user', 'q2'),
    msg('assistant', null, { toolCalls: [{ id: 'c2', type: 'function', function: { name: 't', arguments: '{}' } }] }),
    msg('tool', 'r2', { toolCallId: 'c2' }),
    msg('user', 'q3'),
    msg('assistant', 'a3'),
    msg('user', 'q4'),
    msg('assistant', 'a4'),
  ];
  // 5 groups: [system] [q1,asst,tool] [q2,asst,tool] [q3,a3] [q4,a4]
  assert.equal(tryReactiveCompact(messages), true);
  // Should keep [system] + [q3,a3] + [q4,a4]
  assert.equal(messages.length, 5);
  assert.equal(messages[0]!.content, 'sys');
  assert.equal(messages[1]!.content, 'q3');
  assert.equal(messages[2]!.content, 'a3');
  assert.equal(messages[3]!.content, 'q4');
  assert.equal(messages[4]!.content, 'a4');
});

test('tryReactiveCompact: never orphans user messages from their responses', () => {
  const messages: Message[] = [
    msg('system', 'sys'),
    msg('user', 'q1'),
    msg('assistant', 'a1'),
    msg('user', 'q2'),
    msg('assistant', 'a2'),
    msg('user', 'q3'),
    msg('assistant', 'a3'),
    msg('user', 'q4'),
    msg('assistant', 'a4'),
  ];
  tryReactiveCompact(messages);
  // Verify every user message is followed by its assistant response
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'user') {
      assert.ok(i + 1 < messages.length, 'user message at end without response');
      assert.equal(messages[i + 1]!.role, 'assistant', `user at ${i} not followed by assistant`);
    }
  }
});

test('tryReactiveCompact: post-compaction transcript has no orphaned tool messages', () => {
  const messages: Message[] = [
    msg('system', 'sys'),
    msg('user', 'q1'),
    msg('assistant', null, { toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] }),
    msg('tool', 'r1', { toolCallId: 'c1' }),
    msg('user', 'q2'),
    msg('assistant', 'a2'),
    msg('user', 'q3'),
    msg('assistant', 'a3'),
    msg('user', 'q4'),
    msg('assistant', 'a4'),
  ];
  tryReactiveCompact(messages);
  // After compaction, no tool messages should exist without a preceding assistant toolCalls
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'tool') {
      // The preceding message should be assistant with toolCalls or another tool
      assert.ok(i > 0);
      const prev = messages[i - 1]!;
      assert.ok(
        prev.role === 'tool' || (prev.role === 'assistant' && prev.toolCalls),
        `orphaned tool message at index ${i}`,
      );
    }
  }
});
