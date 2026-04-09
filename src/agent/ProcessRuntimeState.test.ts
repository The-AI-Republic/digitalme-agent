import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialProcessState,
  createProcessAccumulatorState,
  createProcessStore,
  buildHealthSnapshot,
} from './ProcessRuntimeState.js';

describe('ProcessRuntimeState', () => {
  describe('createInitialProcessState', () => {
    it('returns zeroed state with draining false', () => {
      const state = createInitialProcessState();
      assert.strictEqual(state.draining, false);
      assert.strictEqual(state.activeRequestCount, 0);
      assert.strictEqual(state.activeConversationCount, 0);
      assert.strictEqual(state.pendingSubmissionCount, 0);
      assert.strictEqual(state.activeSessionCount, 0);
      assert.strictEqual(state.activeTurnCount, 0);
    });
  });

  describe('createProcessAccumulatorState', () => {
    it('returns zeroed accumulators with startedAt timestamp', () => {
      const acc = createProcessAccumulatorState();
      assert.strictEqual(acc.completedRequests, 0);
      assert.strictEqual(acc.failedRequests, 0);
      assert.ok(acc.startedAt); // ISO string
    });
  });

  describe('createProcessStore', () => {
    it('creates store with initial state', () => {
      const store = createProcessStore();
      const state = store.getState();
      assert.strictEqual(state.draining, false);
      assert.strictEqual(state.activeRequestCount, 0);
    });

    it('updates state immutably', () => {
      const store = createProcessStore();
      const before = store.getState();

      store.setState((s) => ({ ...s, draining: true }));
      const after = store.getState();

      assert.strictEqual(before.draining, false);
      assert.strictEqual(after.draining, true);
      assert.notStrictEqual(before, after);
    });

    it('fires onChange on state change', () => {
      let fired = false;
      const store = createProcessStore((old, next) => {
        fired = true;
        assert.strictEqual(old.activeRequestCount, 0);
        assert.strictEqual(next.activeRequestCount, 1);
      });

      store.setState((s) => ({ ...s, activeRequestCount: 1 }));
      assert.ok(fired);
    });
  });

  describe('buildHealthSnapshot', () => {
    it('builds correct health from state and accumulators', () => {
      const state = {
        ...createInitialProcessState(),
        draining: false,
        activeRequestCount: 3,
        activeConversationCount: 2,
        pendingSubmissionCount: 5,
        activeSessionCount: 4,
        activeTurnCount: 1,
      };
      const acc = {
        completedRequests: 100,
        failedRequests: 5,
        startedAt: '2026-01-01T00:00:00.000Z',
      };

      const health = buildHealthSnapshot(state, acc, 'openai');

      assert.strictEqual(health.model_provider, 'openai');
      assert.strictEqual(health.active_requests, 3);
      assert.strictEqual(health.completed_requests, 100);
      assert.strictEqual(health.failed_requests, 5);
      assert.strictEqual(health.draining, false);
      assert.deepStrictEqual(health.queue, {
        activeCount: 2,
        activeConversations: 2,
        pendingCount: 5,
        draining: false,
      });
      assert.deepStrictEqual(health.sessions, {
        activeSessions: 4,
        activeTurns: 1,
      });
    });

    it('reflects draining state', () => {
      const state = {
        ...createInitialProcessState(),
        draining: true,
      };
      const acc = createProcessAccumulatorState();

      const health = buildHealthSnapshot(state, acc, 'xai');
      assert.strictEqual(health.draining, true);
      const queue = health.queue as Record<string, unknown>;
      assert.strictEqual(queue.draining, true);
    });
  });
});
