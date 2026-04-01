import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRequestSchema, turnRequestSchema } from './schemas.js';

test('verifyRequestSchema accepts valid verification request', () => {
  const result = verifyRequestSchema.safeParse({ type: 'verification', challenge: 'abc123' });
  assert.equal(result.success, true);
});

test('verifyRequestSchema rejects wrong type', () => {
  const result = verifyRequestSchema.safeParse({ type: 'other', challenge: 'abc' });
  assert.equal(result.success, false);
});

test('verifyRequestSchema rejects empty challenge', () => {
  const result = verifyRequestSchema.safeParse({ type: 'verification', challenge: '' });
  assert.equal(result.success, false);
});

test('turnRequestSchema accepts valid turn request', () => {
  const result = turnRequestSchema.safeParse({
    request_id: 'req-1',
    conversation_id: 'conv-1',
    message: 'hello',
    history: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.success, true);
});

test('turnRequestSchema rejects missing fields', () => {
  const result = turnRequestSchema.safeParse({ request_id: 'req-1' });
  assert.equal(result.success, false);
});

test('turnRequestSchema rejects extra fields', () => {
  const result = turnRequestSchema.safeParse({
    request_id: 'req-1',
    conversation_id: 'conv-1',
    message: 'hello',
    history: [],
    extra: 'field',
  });
  assert.equal(result.success, false);
});

test('turnRequestSchema rejects invalid history role', () => {
  const result = turnRequestSchema.safeParse({
    request_id: 'req-1',
    conversation_id: 'conv-1',
    message: 'hello',
    history: [{ role: 'system', content: 'nope' }],
  });
  assert.equal(result.success, false);
});
