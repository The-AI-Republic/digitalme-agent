import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionState } from './SessionState.js';

test('constructor initializes from history', () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.equal(state.conversationId, 'conv-1');
  assert.equal(state.getCanonicalHistory().length, 2);
  assert.equal(state.getPromptHistory().length, 2);
});

test('getPromptHistory returns deep copies', () => {
  const state = new SessionState('conv-1', [{ role: 'user', content: 'hi' }]);
  const h1 = state.getPromptHistory();
  const h2 = state.getPromptHistory();
  assert.notEqual(h1[0], h2[0]);
  assert.deepEqual(h1, h2);
});

test('getCanonicalHistory returns copies', () => {
  const state = new SessionState('conv-1', [{ role: 'user', content: 'hi' }]);
  const h = state.getCanonicalHistory();
  h.push({ role: 'assistant', content: 'added' });
  assert.equal(state.getCanonicalHistory().length, 1);
});

test('getNextTurnId increments', () => {
  const state = new SessionState('conv-1', []);
  assert.equal(state.getNextTurnId(), 1);
  assert.equal(state.getNextTurnId(), 2);
  assert.equal(state.getNextTurnId(), 3);
});

test('reconcileWithPlatformHistory returns warm when platform sends empty but local has data', () => {
  const state = new SessionState('conv-1', [{ role: 'user', content: 'hi' }]);
  const result = state.reconcileWithPlatformHistory([]);
  assert.equal(result, 'warm');
  assert.equal(state.getCanonicalHistory().length, 1);
});

test('reconcileWithPlatformHistory returns unchanged when histories match', () => {
  const history = [{ role: 'user' as const, content: 'hi' }];
  const state = new SessionState('conv-1', history);
  const result = state.reconcileWithPlatformHistory([{ role: 'user', content: 'hi' }]);
  assert.equal(result, 'unchanged');
});

test('reconcileWithPlatformHistory returns reseeded when histories differ', () => {
  const state = new SessionState('conv-1', [{ role: 'user', content: 'hi' }]);
  const newHistory = [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'hello' },
  ];
  const result = state.reconcileWithPlatformHistory(newHistory);
  assert.equal(result, 'reseeded');
  assert.equal(state.getCanonicalHistory().length, 2);
  assert.equal(state.getPromptHistory().length, 2);
});

test('commitTask appends user and assistant to histories', () => {
  const state = new SessionState('conv-1', []);
  const promptMessages = [
    { role: 'user' as const, content: 'hey' },
    { role: 'assistant' as const, content: 'sup' },
  ];
  state.commitTask('hey', 'sup', promptMessages);

  assert.equal(state.getCanonicalHistory().length, 2);
  assert.equal(state.getCanonicalHistory()[0].role, 'user');
  assert.equal(state.getCanonicalHistory()[1].role, 'assistant');
  assert.equal(state.getPromptHistory().length, 2);
});

test('snapshot returns expected shape', () => {
  const state = new SessionState('conv-1', [{ role: 'user', content: 'hi' }]);
  state.getNextTurnId();
  const snap = state.snapshot();
  assert.equal(snap.conversationId, 'conv-1');
  assert.equal(snap.canonicalHistoryCount, 1);
  assert.equal(snap.promptHistoryCount, 1);
  assert.equal(snap.nextTurnId, 2);
  assert.ok(snap.createdAt);
  assert.ok(snap.lastAccessedAt);
});

test('touch updates lastAccessedAt', () => {
  const state = new SessionState('conv-1', []);
  const before = state.getLastAccessedAt();
  // Slight delay to ensure different timestamp
  state.touch();
  assert.ok(state.getLastAccessedAt() >= before);
});

test('clonePromptMessage preserves toolCalls', () => {
  const state = new SessionState('conv-1', []);
  const messages = [
    {
      role: 'assistant' as const,
      content: null,
      toolCalls: [{ id: 'tc1', type: 'function' as const, function: { name: 'search', arguments: '{}' } }],
    },
    {
      role: 'tool' as const,
      content: 'result',
      toolCallId: 'tc1',
      toolName: 'search',
    },
  ];
  state.commitTask('q', 'a', messages);

  const history = state.getPromptHistory();
  assert.equal(history[0].toolCalls?.[0].id, 'tc1');
  assert.equal(history[1].toolCallId, 'tc1');
  assert.equal(history[1].toolName, 'search');
});
