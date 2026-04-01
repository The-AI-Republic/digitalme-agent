import assert from 'node:assert/strict';
import test from 'node:test';
import { TurnContext } from './TurnContext.js';
import type { TurnSubmission } from './types.js';
import type { Message } from '../models/ModelClient.js';

test('constructor copies fields from submission', () => {
  const submission: TurnSubmission = {
    requestId: 'req-1',
    conversationId: 'conv-1',
    userMessage: 'hello',
    history: [{ role: 'user', content: 'hi' }],
  };
  const initial: Message[] = [{ role: 'system', content: 'You are helpful.' }];
  const ctx = new TurnContext(submission, initial);

  assert.equal(ctx.requestId, 'req-1');
  assert.equal(ctx.conversationId, 'conv-1');
  assert.equal(ctx.userMessage, 'hello');
  assert.deepEqual(ctx.history, [{ role: 'user', content: 'hi' }]);
  assert.equal(ctx.signal, undefined);
  assert.equal(ctx.turnCount, 0);
  assert.equal(ctx.tokenUsage, undefined);
});

test('initial messages are copied not shared', () => {
  const initial: Message[] = [{ role: 'system', content: 'sys' }];
  const ctx = new TurnContext(
    { requestId: 'r', conversationId: 'c', userMessage: 'm', history: [] },
    initial,
  );
  ctx.messages.push({ role: 'user', content: 'added' });
  assert.equal(initial.length, 1);
  assert.equal(ctx.messages.length, 2);
});

test('abort signal is passed through', () => {
  const controller = new AbortController();
  const ctx = new TurnContext(
    { requestId: 'r', conversationId: 'c', userMessage: 'm', history: [], signal: controller.signal },
    [],
  );
  assert.equal(ctx.signal, controller.signal);
});
