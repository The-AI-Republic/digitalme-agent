import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeObservers, type RuntimeListeners } from './RuntimeObservers.js';
import { createInitialProcessState, type ProcessRuntimeState } from './ProcessRuntimeState.js';

function makeState(overrides: Partial<ProcessRuntimeState> = {}): ProcessRuntimeState {
  return { ...createInitialProcessState(), ...overrides };
}

describe('RuntimeObservers', () => {
  it('fires onDrainingChanged when draining changes', () => {
    const onDrainingChanged = mock.fn();
    const { onRuntimeStateChange } = createRuntimeObservers({ onDrainingChanged });

    const old = makeState({ draining: false });
    const next = makeState({ draining: true });
    onRuntimeStateChange(old, next);

    assert.strictEqual(onDrainingChanged.mock.callCount(), 1);
    assert.deepStrictEqual(onDrainingChanged.mock.calls[0].arguments, [true]);
  });

  it('does not fire onDrainingChanged when draining is unchanged', () => {
    const onDrainingChanged = mock.fn();
    const { onRuntimeStateChange } = createRuntimeObservers({ onDrainingChanged });

    const old = makeState({ draining: true });
    const next = makeState({ draining: true, activeRequestCount: 1 });
    onRuntimeStateChange(old, next);

    assert.strictEqual(onDrainingChanged.mock.callCount(), 0);
  });

  it('fires onActiveRequestCountChanged when activeRequestCount changes', () => {
    const onActiveRequestCountChanged = mock.fn();
    const { onRuntimeStateChange } = createRuntimeObservers({ onActiveRequestCountChanged });

    const old = makeState({ activeRequestCount: 0 });
    const next = makeState({ activeRequestCount: 3 });
    onRuntimeStateChange(old, next);

    assert.strictEqual(onActiveRequestCountChanged.mock.callCount(), 1);
    assert.deepStrictEqual(onActiveRequestCountChanged.mock.calls[0].arguments, [3]);
  });

  it('does not fire onActiveRequestCountChanged when count is unchanged', () => {
    const onActiveRequestCountChanged = mock.fn();
    const { onRuntimeStateChange } = createRuntimeObservers({ onActiveRequestCountChanged });

    const old = makeState({ activeRequestCount: 2 });
    const next = makeState({ activeRequestCount: 2, draining: true });
    onRuntimeStateChange(old, next);

    assert.strictEqual(onActiveRequestCountChanged.mock.callCount(), 0);
  });

  it('fires onActiveSessionCountChanged when session or turn count changes', () => {
    const onActiveSessionCountChanged = mock.fn();
    const { onRuntimeStateChange } = createRuntimeObservers({ onActiveSessionCountChanged });

    // Session count changes
    onRuntimeStateChange(
      makeState({ activeSessionCount: 1, activeTurnCount: 0 }),
      makeState({ activeSessionCount: 2, activeTurnCount: 0 }),
    );
    assert.strictEqual(onActiveSessionCountChanged.mock.callCount(), 1);
    assert.deepStrictEqual(onActiveSessionCountChanged.mock.calls[0].arguments, [2, 0]);

    // Turn count changes
    onRuntimeStateChange(
      makeState({ activeSessionCount: 2, activeTurnCount: 0 }),
      makeState({ activeSessionCount: 2, activeTurnCount: 1 }),
    );
    assert.strictEqual(onActiveSessionCountChanged.mock.callCount(), 2);
    assert.deepStrictEqual(onActiveSessionCountChanged.mock.calls[1].arguments, [2, 1]);
  });

  it('fires onQueuePressureChanged when conversation or pending count changes', () => {
    const onQueuePressureChanged = mock.fn();
    const { onRuntimeStateChange } = createRuntimeObservers({ onQueuePressureChanged });

    onRuntimeStateChange(
      makeState({ activeConversationCount: 1, pendingSubmissionCount: 0 }),
      makeState({ activeConversationCount: 2, pendingSubmissionCount: 3 }),
    );
    assert.strictEqual(onQueuePressureChanged.mock.callCount(), 1);
    assert.deepStrictEqual(onQueuePressureChanged.mock.calls[0].arguments, [2, 3]);
  });

  it('does not fire any listener when nothing changed', () => {
    const listeners: RuntimeListeners = {
      onDrainingChanged: mock.fn(),
      onActiveRequestCountChanged: mock.fn(),
      onActiveSessionCountChanged: mock.fn(),
      onQueuePressureChanged: mock.fn(),
    };
    const { onRuntimeStateChange } = createRuntimeObservers(listeners);

    const state = makeState({ activeRequestCount: 1, draining: false });
    onRuntimeStateChange(state, state);

    assert.strictEqual((listeners.onDrainingChanged as ReturnType<typeof mock.fn>).mock.callCount(), 0);
    assert.strictEqual((listeners.onActiveRequestCountChanged as ReturnType<typeof mock.fn>).mock.callCount(), 0);
    assert.strictEqual((listeners.onActiveSessionCountChanged as ReturnType<typeof mock.fn>).mock.callCount(), 0);
    assert.strictEqual((listeners.onQueuePressureChanged as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('fires multiple listeners for multiple field changes', () => {
    const onDrainingChanged = mock.fn();
    const onActiveRequestCountChanged = mock.fn();
    const { onRuntimeStateChange } = createRuntimeObservers({
      onDrainingChanged,
      onActiveRequestCountChanged,
    });

    onRuntimeStateChange(
      makeState({ draining: false, activeRequestCount: 0 }),
      makeState({ draining: true, activeRequestCount: 5 }),
    );

    assert.strictEqual(onDrainingChanged.mock.callCount(), 1);
    assert.strictEqual(onActiveRequestCountChanged.mock.callCount(), 1);
  });

  it('works with no listeners registered', () => {
    const { onRuntimeStateChange } = createRuntimeObservers();

    // Should not throw
    onRuntimeStateChange(
      makeState({ draining: false }),
      makeState({ draining: true }),
    );
  });
});
