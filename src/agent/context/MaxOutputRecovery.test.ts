import test from 'node:test';
import assert from 'node:assert/strict';

import { MaxOutputRecovery } from './MaxOutputRecovery.js';

test('isTruncated detects truncated responses', () => {
  const mor = new MaxOutputRecovery({ maxRetries: 2 });
  assert.equal(mor.isTruncated({ type: 'final_text', text: 'partial', truncated: true }), true);
  assert.equal(mor.isTruncated({ type: 'final_text', text: 'complete' }), false);
  assert.equal(mor.isTruncated({ type: 'tool_calls', calls: [] }), false);
});

test('canRetry returns true up to maxRetries', () => {
  const mor = new MaxOutputRecovery({ maxRetries: 2 });
  assert.equal(mor.canRetry(), true);
  mor.buildContinuationMessage();
  assert.equal(mor.canRetry(), true);
  mor.buildContinuationMessage();
  assert.equal(mor.canRetry(), false);
});

test('buildContinuationMessage returns resume prompt', () => {
  const mor = new MaxOutputRecovery({ maxRetries: 2 });
  const msg = mor.buildContinuationMessage();
  assert.equal(msg.role, 'user');
  assert.ok(msg.content!.includes('Resume directly'));
});

test('getEscalatedMaxTokens returns value on first attempt', () => {
  const mor = new MaxOutputRecovery({ maxRetries: 2, escalatedMaxTokens: 64000 });
  assert.equal(mor.getEscalatedMaxTokens(), 64000);
  mor.buildContinuationMessage();
  assert.equal(mor.getEscalatedMaxTokens(), undefined);
});

test('resetForNewTurn resets retry count', () => {
  const mor = new MaxOutputRecovery({ maxRetries: 1 });
  mor.buildContinuationMessage();
  assert.equal(mor.canRetry(), false);
  mor.resetForNewTurn();
  assert.equal(mor.canRetry(), true);
});
