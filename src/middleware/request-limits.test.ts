import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTurnLimits } from './request-limits.js';
import { testConfig } from '../test/fixtures.js';
import type { TurnRequest } from '../protocol/types.js';

test('valid request passes validation', () => {
  const payload: TurnRequest = {
    request_id: 'req-1',
    conversation_id: 'conv-1',
    message: 'hello',
    history: [],
  };
  assert.doesNotThrow(() => validateTurnLimits(testConfig, payload));
});

test('message exceeding max length throws', () => {
  const payload: TurnRequest = {
    request_id: 'req-1',
    conversation_id: 'conv-1',
    message: 'x'.repeat(testConfig.limits.max_message_length + 1),
    history: [],
  };
  assert.throws(
    () => validateTurnLimits(testConfig, payload),
    { message: 'message_too_long' },
  );
});

test('history exceeding max length throws', () => {
  const history = Array.from({ length: testConfig.limits.max_history_messages + 1 }, (_, i) => ({
    role: 'user' as const,
    content: `msg-${i}`,
  }));
  const payload: TurnRequest = {
    request_id: 'req-1',
    conversation_id: 'conv-1',
    message: 'hello',
    history,
  };
  assert.throws(
    () => validateTurnLimits(testConfig, payload),
    { message: 'history_too_long' },
  );
});

test('message exactly at limit passes', () => {
  const payload: TurnRequest = {
    request_id: 'req-1',
    conversation_id: 'conv-1',
    message: 'x'.repeat(testConfig.limits.max_message_length),
    history: [],
  };
  assert.doesNotThrow(() => validateTurnLimits(testConfig, payload));
});
