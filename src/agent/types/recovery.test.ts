import test from 'node:test';
import assert from 'node:assert/strict';

import { initialRecoveryState, RECOVERY_LIMITS } from './recovery.js';

test('initialRecoveryState returns zeroed state', () => {
  const state = initialRecoveryState();
  assert.equal(state.hasAttemptedReactiveCompact, false);
  assert.equal(state.maxOutputRecoveryCount, 0);
  assert.equal(state.accumulatedText, '');
  assert.equal(state.apiRetryCount, 0);
  assert.equal(state.fallbackAttempted, false);
  assert.equal(state.lastTransition, undefined);
});

test('RECOVERY_LIMITS has expected values', () => {
  assert.equal(RECOVERY_LIMITS.MAX_OUTPUT_RECOVERY_ATTEMPTS, 3);
  assert.equal(RECOVERY_LIMITS.MAX_API_RETRIES, 3);
  assert.equal(RECOVERY_LIMITS.FALLBACK_AFTER_CONSECUTIVE_529, 3);
});
