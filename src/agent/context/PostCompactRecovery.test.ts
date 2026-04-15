import test from 'node:test';
import assert from 'node:assert/strict';

import { PostCompactRecovery } from './PostCompactRecovery.js';

test('buildRecoveryMessages returns empty array when no characterContext', () => {
  const recovery = new PostCompactRecovery({ maxRecoveryTokens: 1000 });
  const result = recovery.buildRecoveryMessages({});
  assert.deepEqual(result, []);
});

test('buildRecoveryMessages returns empty array when characterContext is empty string', () => {
  const recovery = new PostCompactRecovery({ maxRecoveryTokens: 1000 });
  const result = recovery.buildRecoveryMessages({ characterContext: '' });
  assert.deepEqual(result, []);
});

test('buildRecoveryMessages returns message with full context when within budget', () => {
  const recovery = new PostCompactRecovery({ maxRecoveryTokens: 1000 });
  const context = 'This is the character context.';
  const result = recovery.buildRecoveryMessages({ characterContext: context });

  assert.equal(result.length, 1);
  assert.equal(result[0].role, 'user');
  assert.equal(result[0].content, `Additional context:\n${context}`);
  assert.ok(result[0].id);
});

test('buildRecoveryMessages truncates context that exceeds token budget', () => {
  const maxTokens = 10; // 10 tokens * 4 bytes = 40 chars max
  const recovery = new PostCompactRecovery({ maxRecoveryTokens: maxTokens });
  const longContext = 'A'.repeat(200);

  const result = recovery.buildRecoveryMessages({ characterContext: longContext });

  assert.equal(result.length, 1);
  // Content should be "Additional context:\n" + 40 chars of 'A'
  const expectedContent = `Additional context:\n${'A'.repeat(40)}`;
  assert.equal(result[0].content, expectedContent);
});

test('buildRecoveryMessages preserves content exactly at the boundary', () => {
  const maxTokens = 25; // 25 * 4 = 100 chars
  const recovery = new PostCompactRecovery({ maxRecoveryTokens: maxTokens });
  const exactContext = 'B'.repeat(100);

  const result = recovery.buildRecoveryMessages({ characterContext: exactContext });

  assert.equal(result.length, 1);
  // At exactly 100 chars = 25 tokens, should NOT truncate
  assert.equal(result[0].content, `Additional context:\n${exactContext}`);
});

test('buildRecoveryMessages truncates at one char over budget', () => {
  const maxTokens = 25; // 25 * 4 = 100 chars
  const recovery = new PostCompactRecovery({ maxRecoveryTokens: maxTokens });
  const overContext = 'C'.repeat(101); // ceil(101/4) = 26 tokens > 25

  const result = recovery.buildRecoveryMessages({ characterContext: overContext });

  assert.equal(result.length, 1);
  assert.equal(result[0].content, `Additional context:\n${'C'.repeat(100)}`);
});

test('buildRecoveryMessages generates unique ids per call', () => {
  const recovery = new PostCompactRecovery({ maxRecoveryTokens: 1000 });
  const r1 = recovery.buildRecoveryMessages({ characterContext: 'ctx1' });
  const r2 = recovery.buildRecoveryMessages({ characterContext: 'ctx2' });

  assert.notEqual(r1[0].id, r2[0].id);
});
