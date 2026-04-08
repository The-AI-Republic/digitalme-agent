import assert from 'node:assert/strict';
import test from 'node:test';
import { HealthMonitor } from './health-monitor.js';

test('snapshot includes status ok and agent health', () => {
  const fakeAgent = {
    getHealth: () => ({
      model_provider: 'openai',
      active_requests: 2,
      completed_requests: 10,
      failed_requests: 1,
      queue: {},
      sessions: {},
      draining: false,
    }),
  };

  const monitor = new HealthMonitor(fakeAgent as any);
  const snap = monitor.snapshot();

  assert.equal(snap.status, 'ok');
  assert.equal(snap.model_provider, 'openai');
  assert.equal(snap.active_requests, 2);
  assert.equal(snap.completed_requests, 10);
  assert.equal(snap.failed_requests, 1);
  assert.equal(snap.draining, false);
});
