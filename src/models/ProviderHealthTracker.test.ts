import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderHealthTracker } from './ProviderHealthTracker.js';
import type { HealthEvent } from './types.js';

function makeEvent(
  overrides: Partial<HealthEvent> = {},
): HealthEvent {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    success: true,
    latencyMs: 100,
    timestamp: Date.now(),
    ...overrides,
  };
}

// --- Basic tracking ---

test('ProviderHealthTracker: new provider is healthy by default', () => {
  const tracker = new ProviderHealthTracker();
  assert.ok(tracker.isHealthy('openai'));
});

test('ProviderHealthTracker: snapshot for unknown provider returns zeroes', () => {
  const tracker = new ProviderHealthTracker();
  const snap = tracker.getSnapshot('openai');
  assert.equal(snap.provider, 'openai');
  assert.equal(snap.successes, 0);
  assert.equal(snap.failures, 0);
  assert.equal(snap.failureRate, 0);
  assert.equal(snap.healthy, true);
  assert.equal(snap.avgLatencyMs, 0);
  assert.equal(snap.circuitOpenedAt, undefined);
});

test('ProviderHealthTracker: records successes correctly', () => {
  const tracker = new ProviderHealthTracker();
  tracker.recordEvent(makeEvent({ success: true }));
  tracker.recordEvent(makeEvent({ success: true }));
  tracker.recordEvent(makeEvent({ success: true }));

  const snap = tracker.getSnapshot('openai');
  assert.equal(snap.successes, 3);
  assert.equal(snap.failures, 0);
  assert.equal(snap.failureRate, 0);
  assert.ok(snap.healthy);
});

test('ProviderHealthTracker: records failures correctly', () => {
  const tracker = new ProviderHealthTracker();
  tracker.recordEvent(makeEvent({ success: false }));
  tracker.recordEvent(makeEvent({ success: true }));
  tracker.recordEvent(makeEvent({ success: false }));

  const snap = tracker.getSnapshot('openai');
  assert.equal(snap.successes, 1);
  assert.equal(snap.failures, 2);
  assert.ok(Math.abs(snap.failureRate - 2 / 3) < 0.01);
});

// --- Latency tracking ---

test('ProviderHealthTracker: computes average latency from successful events', () => {
  const tracker = new ProviderHealthTracker();
  tracker.recordEvent(makeEvent({ success: true, latencyMs: 100 }));
  tracker.recordEvent(makeEvent({ success: true, latencyMs: 200 }));
  tracker.recordEvent(makeEvent({ success: true, latencyMs: 300 }));

  const snap = tracker.getSnapshot('openai');
  assert.equal(snap.avgLatencyMs, 200);
});

test('ProviderHealthTracker: average latency excludes failures', () => {
  const tracker = new ProviderHealthTracker();
  tracker.recordEvent(makeEvent({ success: true, latencyMs: 100 }));
  tracker.recordEvent(makeEvent({ success: false, latencyMs: 5000 }));
  tracker.recordEvent(makeEvent({ success: true, latencyMs: 300 }));

  const snap = tracker.getSnapshot('openai');
  assert.equal(snap.avgLatencyMs, 200);
});

// --- Sliding window ---

test('ProviderHealthTracker: sliding window trims old events', () => {
  const tracker = new ProviderHealthTracker({ windowSize: 3, failureThreshold: 0.5, recoveryAfterSeconds: 60 });

  // Fill window with failures
  tracker.recordEvent(makeEvent({ success: false }));
  tracker.recordEvent(makeEvent({ success: false }));
  tracker.recordEvent(makeEvent({ success: false }));

  // Now add successes that push failures out of the window
  tracker.recordEvent(makeEvent({ success: true }));
  tracker.recordEvent(makeEvent({ success: true }));
  tracker.recordEvent(makeEvent({ success: true }));

  const snap = tracker.getSnapshot('openai');
  assert.equal(snap.successes, 3);
  assert.equal(snap.failures, 0);
});

// --- Circuit breaker ---

test('ProviderHealthTracker: circuit opens when failure rate exceeds threshold', () => {
  const tracker = new ProviderHealthTracker({
    windowSize: 10,
    failureThreshold: 0.5,
    recoveryAfterSeconds: 60,
  });

  // 6 failures out of 10 = 60% > 50% threshold
  for (let i = 0; i < 4; i++) tracker.recordEvent(makeEvent({ success: true }));
  for (let i = 0; i < 6; i++) tracker.recordEvent(makeEvent({ success: false }));

  assert.ok(!tracker.isHealthy('openai'));
  const snap = tracker.getSnapshot('openai');
  assert.ok(!snap.healthy);
  assert.ok(snap.circuitOpenedAt !== undefined);
});

test('ProviderHealthTracker: circuit stays closed below threshold', () => {
  const tracker = new ProviderHealthTracker({
    windowSize: 10,
    failureThreshold: 0.5,
    recoveryAfterSeconds: 60,
  });

  // 4 failures out of 10 = 40% < 50% threshold
  for (let i = 0; i < 6; i++) tracker.recordEvent(makeEvent({ success: true }));
  for (let i = 0; i < 4; i++) tracker.recordEvent(makeEvent({ success: false }));

  assert.ok(tracker.isHealthy('openai'));
});

test('ProviderHealthTracker: circuit closes on success after being open', () => {
  const tracker = new ProviderHealthTracker({
    windowSize: 4,
    failureThreshold: 0.5,
    recoveryAfterSeconds: 60,
  });

  // Trip the circuit
  tracker.recordEvent(makeEvent({ success: false }));
  tracker.recordEvent(makeEvent({ success: false }));
  assert.ok(!tracker.isHealthy('openai'));

  // A success closes the circuit
  tracker.recordEvent(makeEvent({ success: true }));
  assert.ok(tracker.isHealthy('openai'));
  assert.equal(tracker.getSnapshot('openai').circuitOpenedAt, undefined);
});

test('ProviderHealthTracker: half-open state allows probe after recovery period', () => {
  const now = Date.now();
  const tracker = new ProviderHealthTracker({
    windowSize: 10,
    failureThreshold: 0.5,
    recoveryAfterSeconds: 30,
  });

  // Trip the circuit
  for (let i = 0; i < 6; i++) {
    tracker.recordEvent(makeEvent({ success: false, timestamp: now }));
  }
  assert.ok(!tracker.isHealthy('openai', now));

  // Not enough time has passed
  assert.ok(!tracker.isHealthy('openai', now + 15_000));

  // Enough time has passed — half-open allows probe
  assert.ok(tracker.isHealthy('openai', now + 31_000));
});

// --- Multiple providers ---

test('ProviderHealthTracker: tracks providers independently', () => {
  const tracker = new ProviderHealthTracker();

  tracker.recordEvent(makeEvent({ provider: 'openai', success: true }));
  tracker.recordEvent(makeEvent({ provider: 'anthropic', success: false }));

  const openaiSnap = tracker.getSnapshot('openai');
  const anthropicSnap = tracker.getSnapshot('anthropic');

  assert.equal(openaiSnap.successes, 1);
  assert.equal(openaiSnap.failures, 0);
  assert.equal(anthropicSnap.successes, 0);
  assert.equal(anthropicSnap.failures, 1);
});

test('ProviderHealthTracker: getAllSnapshots returns all tracked providers', () => {
  const tracker = new ProviderHealthTracker();
  tracker.recordEvent(makeEvent({ provider: 'openai' }));
  tracker.recordEvent(makeEvent({ provider: 'anthropic' }));
  tracker.recordEvent(makeEvent({ provider: 'google-ai-studio' }));

  const snapshots = tracker.getAllSnapshots();
  const providers = snapshots.map(s => s.provider).sort();
  assert.deepEqual(providers, ['anthropic', 'google-ai-studio', 'openai']);
});

// --- Reset ---

test('ProviderHealthTracker: reset clears all data', () => {
  const tracker = new ProviderHealthTracker();
  tracker.recordEvent(makeEvent({ success: false }));
  tracker.recordEvent(makeEvent({ success: false }));

  tracker.reset();

  assert.ok(tracker.isHealthy('openai'));
  assert.equal(tracker.getAllSnapshots().length, 0);
});

// --- Edge cases ---

test('ProviderHealthTracker: single failure does not trip circuit at 0.5 threshold', () => {
  const tracker = new ProviderHealthTracker({
    windowSize: 10,
    failureThreshold: 0.5,
    recoveryAfterSeconds: 60,
  });

  tracker.recordEvent(makeEvent({ success: true }));
  tracker.recordEvent(makeEvent({ success: true }));
  tracker.recordEvent(makeEvent({ success: false }));

  assert.ok(tracker.isHealthy('openai'));
});

test('ProviderHealthTracker: error category is preserved in events', () => {
  const tracker = new ProviderHealthTracker();
  tracker.recordEvent(makeEvent({ success: false, errorCategory: 'overloaded' }));

  // Verify the error category doesn't affect health calculation
  // (it's for observability, not routing decisions)
  const snap = tracker.getSnapshot('openai');
  assert.equal(snap.failures, 1);
});

test('ProviderHealthTracker: exactly at threshold trips circuit', () => {
  const tracker = new ProviderHealthTracker({
    windowSize: 4,
    failureThreshold: 0.5,
    recoveryAfterSeconds: 60,
  });

  // 2 out of 4 = exactly 50%
  tracker.recordEvent(makeEvent({ success: true }));
  tracker.recordEvent(makeEvent({ success: true }));
  tracker.recordEvent(makeEvent({ success: false }));
  tracker.recordEvent(makeEvent({ success: false }));

  assert.ok(!tracker.isHealthy('openai'));
});
