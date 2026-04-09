import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessStore } from './ProcessRuntimeState.js';
import { createRuntimeObservers } from './RuntimeObservers.js';

describe('RuntimeStore + Observers integration', () => {
  it('observer fires when store state changes', () => {
    const onDrainingChanged = mock.fn();
    const onActiveRequestCountChanged = mock.fn();
    const { onRuntimeStateChange } = createRuntimeObservers({
      onDrainingChanged,
      onActiveRequestCountChanged,
    });
    const store = createProcessStore(onRuntimeStateChange);

    store.setState((s) => ({ ...s, draining: true }));
    assert.strictEqual(onDrainingChanged.mock.callCount(), 1);
    assert.deepStrictEqual(onDrainingChanged.mock.calls[0].arguments, [true]);

    store.setState((s) => ({ ...s, activeRequestCount: 3 }));
    assert.strictEqual(onActiveRequestCountChanged.mock.callCount(), 1);
    assert.deepStrictEqual(onActiveRequestCountChanged.mock.calls[0].arguments, [3]);
  });

  it('observer does not fire on identity-equal state', () => {
    const onDrainingChanged = mock.fn();
    const { onRuntimeStateChange } = createRuntimeObservers({ onDrainingChanged });
    const store = createProcessStore(onRuntimeStateChange);

    store.setState((s) => s); // identity
    assert.strictEqual(onDrainingChanged.mock.callCount(), 0);
  });

  it('subscriber is notified after observer fires', () => {
    const callOrder: string[] = [];
    const { onRuntimeStateChange } = createRuntimeObservers({
      onDrainingChanged: () => callOrder.push('observer'),
    });
    const store = createProcessStore(onRuntimeStateChange);
    store.subscribe(() => callOrder.push('subscriber'));

    store.setState((s) => ({ ...s, draining: true }));
    assert.deepStrictEqual(callOrder, ['observer', 'subscriber']);
  });

  it('multiple state updates produce correct cumulative result', () => {
    const requestCounts: number[] = [];
    const { onRuntimeStateChange } = createRuntimeObservers({
      onActiveRequestCountChanged: (count) => requestCounts.push(count),
    });
    const store = createProcessStore(onRuntimeStateChange);

    store.setState((s) => ({ ...s, activeRequestCount: s.activeRequestCount + 1 }));
    store.setState((s) => ({ ...s, activeRequestCount: s.activeRequestCount + 1 }));
    store.setState((s) => ({ ...s, activeRequestCount: s.activeRequestCount + 1 }));

    assert.deepStrictEqual(requestCounts, [1, 2, 3]);
    assert.strictEqual(store.getState().activeRequestCount, 3);
  });

  it('SubmissionQueue syncs conversation and pending counts to store', () => {
    const pressureUpdates: Array<[number, number]> = [];
    const { onRuntimeStateChange } = createRuntimeObservers({
      onQueuePressureChanged: (active, pending) => pressureUpdates.push([active, pending]),
    });
    const store = createProcessStore(onRuntimeStateChange);

    // Simulate what SubmissionQueue.syncStoreStats does
    store.setState((s) => ({
      ...s,
      activeConversationCount: 2,
      pendingSubmissionCount: 5,
    }));
    assert.deepStrictEqual(pressureUpdates, [[2, 5]]);

    // Conversation finishes
    store.setState((s) => ({
      ...s,
      activeConversationCount: 1,
      pendingSubmissionCount: 3,
    }));
    assert.deepStrictEqual(pressureUpdates, [[2, 5], [1, 3]]);
  });
});
