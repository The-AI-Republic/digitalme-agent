import test from 'node:test';
import assert from 'node:assert/strict';
import { generateId, type Message } from '../models/ModelClient.js';
import { SessionState } from './SessionState.js';

function msg(role: Message['role'], content: string | null, extra?: Partial<Message>): Message {
  return { role, content, id: generateId(), timestamp: new Date().toISOString(), ...extra };
}

test('SessionState initializes from platform history', () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);

  const messages = state.getMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'hello');
  assert.ok(messages[0].id, 'messages should have id');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, 'hi');
});

test('getCanonicalHistory filters to user/assistant text only', () => {
  const state = new SessionState('conv-1', []);

  state.appendMessages([
    msg('user', 'search cats'),
    msg('assistant', null, {
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } }],
    }),
    msg('tool', 'cats are great', { toolCallId: 'call-1', toolName: 'search' }),
    msg('assistant', 'Here are results about cats'),
  ]);

  const canonical = state.getCanonicalHistory();
  assert.equal(canonical.length, 2);
  assert.equal(canonical[0].role, 'user');
  assert.equal(canonical[0].content, 'search cats');
  assert.equal(canonical[1].role, 'assistant');
  assert.equal(canonical[1].content, 'Here are results about cats');
});

test('getCanonicalHistory excludes synthetic messages', () => {
  const state = new SessionState('conv-1', []);

  state.appendMessages([
    msg('assistant', '[Compacted summary]', { synthetic: true }),
    msg('user', 'hello'),
    msg('assistant', 'hi'),
  ]);

  const canonical = state.getCanonicalHistory();
  assert.equal(canonical.length, 2);
  assert.equal(canonical[0].role, 'user');
  assert.equal(canonical[1].role, 'assistant');
});

test('appendMessages adds new messages and increments revision', () => {
  const state = new SessionState('conv-1', []);
  const rev0 = state.getRevision();

  state.appendMessages([
    msg('user', 'hello'),
    msg('assistant', 'hi'),
  ]);

  assert.equal(state.getMessages().length, 2);
  assert.equal(state.getRevision(), rev0 + 1);
});

test('appendMessages clones messages to prevent external mutation', () => {
  const state = new SessionState('conv-1', []);
  const original = msg('user', 'hello');
  state.appendMessages([original]);

  // Mutate the original
  original.content = 'mutated';

  // State should have the original content
  assert.equal(state.getMessages()[0].content, 'hello');
});

test('initializeFromTranscript replaces messages', () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'old' },
  ]);

  const transcriptMessages = [
    msg('user', 'transcript user'),
    msg('assistant', null, {
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } }],
    }),
    msg('tool', 'result', { toolCallId: 'call-1', toolName: 'search' }),
    msg('assistant', 'transcript response'),
  ];

  state.initializeFromTranscript(transcriptMessages);

  const messages = state.getMessages();
  assert.equal(messages.length, 4);
  assert.equal(messages[0].content, 'transcript user');
  assert.equal(messages[3].content, 'transcript response');
});

test('reconcileWithPlatformHistory returns warm when platform is empty but state has data', () => {
  const state = new SessionState('conv-1', []);
  state.appendMessages([msg('user', 'hello'), msg('assistant', 'hi')]);

  const result = state.reconcileWithPlatformHistory([]);
  assert.equal(result, 'warm');
});

test('reconcileWithPlatformHistory returns unchanged when histories match', () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);

  const result = state.reconcileWithPlatformHistory([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  assert.equal(result, 'unchanged');
});

test('reconcileWithPlatformHistory reseeds when platform history diverges', () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  // Add tool call messages so getMessages has more than canonical
  state.appendMessages([
    msg('user', 'search'),
    msg('assistant', null, {
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } }],
    }),
    msg('tool', 'result', { toolCallId: 'call-1', toolName: 'search' }),
    msg('assistant', 'search done'),
  ]);

  const result = state.reconcileWithPlatformHistory([
    { role: 'user', content: 'new start' },
    { role: 'assistant', content: 'new response' },
  ]);
  assert.equal(result, 'reseeded');
  // Messages should be replaced with platform history
  const messages = state.getMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'new start');
});

test('compactHistory replaces messages with synthetic summary', () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old reply' },
  ]);
  const rev = state.getRevision();

  const result = state.compactHistory('Summary of conversation', rev);
  assert.equal(result, true);

  const messages = state.getMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, 'Summary of conversation');
  assert.equal(messages[0].synthetic, true);
  assert.ok(messages[0].id);
});

test('compactHistory returns false if revision advanced', () => {
  const state = new SessionState('conv-1', []);
  const rev = state.getRevision();

  state.appendMessages([msg('user', 'hello')]);

  const result = state.compactHistory('Summary', rev);
  assert.equal(result, false);
});

test('snapshot reflects current state', () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);

  const snap = state.snapshot();
  assert.equal(snap.conversationId, 'conv-1');
  assert.equal(snap.canonicalHistoryCount, 2);
  assert.equal(snap.messageCount, 2);
  assert.equal(snap.nextTurnId, 1);
});

test('getNextTurnId auto-increments', () => {
  const state = new SessionState('conv-1', []);
  assert.equal(state.getNextTurnId(), 1);
  assert.equal(state.getNextTurnId(), 2);
  assert.equal(state.getNextTurnId(), 3);
});

test('getMessages returns cloned messages', () => {
  const state = new SessionState('conv-1', [
    { role: 'user', content: 'hello' },
  ]);

  const messages = state.getMessages();
  messages[0].content = 'mutated';

  // Original should be unchanged
  assert.equal(state.getMessages()[0].content, 'hello');
});
