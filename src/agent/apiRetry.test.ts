import test from 'node:test';
import assert from 'node:assert/strict';

import { categorizeApiError, exponentialBackoff } from './apiRetry.js';

// --- categorizeApiError ---

test('categorizeApiError: 429 -> rate_limit', () => {
  assert.equal(categorizeApiError({ status: 429, message: 'Too Many Requests' }), 'rate_limit');
});

test('categorizeApiError: 529 -> overloaded', () => {
  assert.equal(categorizeApiError({ status: 529, message: 'Overloaded' }), 'overloaded');
});

test('categorizeApiError: 413 -> context_overflow', () => {
  assert.equal(categorizeApiError({ status: 413, message: 'Payload Too Large' }), 'context_overflow');
});

test('categorizeApiError: 401 -> auth_error', () => {
  assert.equal(categorizeApiError({ status: 401, message: 'Unauthorized' }), 'auth_error');
});

test('categorizeApiError: 403 -> auth_error', () => {
  assert.equal(categorizeApiError({ status: 403, message: 'Forbidden' }), 'auth_error');
});

test('categorizeApiError: 500 -> server_error', () => {
  assert.equal(categorizeApiError({ status: 500, message: 'Internal Server Error' }), 'server_error');
});

test('categorizeApiError: 503 -> server_error', () => {
  assert.equal(categorizeApiError({ status: 503, message: 'Service Unavailable' }), 'server_error');
});

test('categorizeApiError: 502 -> server_error', () => {
  assert.equal(categorizeApiError({ status: 502, message: 'Bad Gateway' }), 'server_error');
});

test('categorizeApiError: unknown status -> unknown', () => {
  assert.equal(categorizeApiError({ status: 418, message: "I'm a teapot" }), 'unknown');
});

test('categorizeApiError: no status, rate limit in message -> rate_limit', () => {
  assert.equal(categorizeApiError(new Error('rate limit exceeded')), 'rate_limit');
});

test('categorizeApiError: no status, too many requests in message -> rate_limit', () => {
  assert.equal(categorizeApiError(new Error('Too Many Requests')), 'rate_limit');
});

test('categorizeApiError: no status, overloaded in message -> overloaded', () => {
  assert.equal(categorizeApiError(new Error('Model is overloaded')), 'overloaded');
});

test('categorizeApiError: no status, prompt too long in message -> context_overflow', () => {
  assert.equal(categorizeApiError(new Error('prompt is too long')), 'context_overflow');
});

test('categorizeApiError: no status, context length in message -> context_overflow', () => {
  assert.equal(categorizeApiError(new Error("This model's maximum context length is 128000")), 'context_overflow');
});

test('categorizeApiError: no status, content too large in message -> context_overflow', () => {
  assert.equal(categorizeApiError(new Error('Content too large for model')), 'context_overflow');
});

test('categorizeApiError: no status, unauthorized in message -> auth_error', () => {
  assert.equal(categorizeApiError(new Error('Unauthorized access')), 'auth_error');
});

test('categorizeApiError: no status, unrecognized message -> unknown', () => {
  assert.equal(categorizeApiError(new Error('something completely different')), 'unknown');
});

test('categorizeApiError: non-Error non-object -> unknown', () => {
  assert.equal(categorizeApiError('just a string'), 'unknown');
});

test('categorizeApiError: null -> unknown', () => {
  assert.equal(categorizeApiError(null), 'unknown');
});

// --- exponentialBackoff ---

test('exponentialBackoff: attempt 0 waits ~100ms', async () => {
  const start = Date.now();
  await exponentialBackoff(0);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 80, `Expected >= 80ms, got ${elapsed}ms`);
  assert.ok(elapsed < 300, `Expected < 300ms, got ${elapsed}ms`);
});

test('exponentialBackoff: attempt 1 waits ~200ms', async () => {
  const start = Date.now();
  await exponentialBackoff(1);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 150, `Expected >= 150ms, got ${elapsed}ms`);
  assert.ok(elapsed < 500, `Expected < 500ms, got ${elapsed}ms`);
});
