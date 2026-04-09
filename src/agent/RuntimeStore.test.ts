import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './RuntimeStore.js';

describe('RuntimeStore', () => {
  it('returns initial state from getState', () => {
    const store = createStore({ count: 0 });
    assert.deepStrictEqual(store.getState(), { count: 0 });
  });

  it('updates state via setState', () => {
    const store = createStore({ count: 0 });
    store.setState((s) => ({ ...s, count: 1 }));
    assert.deepStrictEqual(store.getState(), { count: 1 });
  });

  it('short-circuits when updater returns same reference (Object.is)', () => {
    const onChange = mock.fn();
    const initial = { count: 0 };
    const store = createStore(initial, onChange);

    store.setState((s) => s); // identity — returns same reference
    assert.strictEqual(onChange.mock.callCount(), 0);
    assert.strictEqual(store.getState(), initial);
  });

  it('fires onChange with old and new state', () => {
    const onChange = mock.fn();
    const store = createStore({ count: 0 }, onChange);

    store.setState((s) => ({ ...s, count: 5 }));
    assert.strictEqual(onChange.mock.callCount(), 1);

    const [oldState, newState] = onChange.mock.calls[0].arguments;
    assert.deepStrictEqual(oldState, { count: 0 });
    assert.deepStrictEqual(newState, { count: 5 });
  });

  it('does not fire onChange when state is identity-equal', () => {
    const onChange = mock.fn();
    const store = createStore({ count: 0 }, onChange);

    store.setState((s) => s);
    assert.strictEqual(onChange.mock.callCount(), 0);
  });

  it('notifies subscribers after onChange', () => {
    const onChange = mock.fn();
    const listener = mock.fn();
    const store = createStore({ count: 0 }, onChange);
    store.subscribe(listener);

    store.setState((s) => ({ ...s, count: 1 }));

    assert.strictEqual(onChange.mock.callCount(), 1);
    assert.strictEqual(listener.mock.callCount(), 1);
  });

  it('does not notify subscribers on no-op setState', () => {
    const listener = mock.fn();
    const store = createStore({ count: 0 });
    store.subscribe(listener);

    store.setState((s) => s);
    assert.strictEqual(listener.mock.callCount(), 0);
  });

  it('unsubscribe removes listener', () => {
    const listener = mock.fn();
    const store = createStore({ count: 0 });
    const unsub = store.subscribe(listener);

    store.setState((s) => ({ ...s, count: 1 }));
    assert.strictEqual(listener.mock.callCount(), 1);

    unsub();
    store.setState((s) => ({ ...s, count: 2 }));
    assert.strictEqual(listener.mock.callCount(), 1); // still 1
  });

  it('supports multiple subscribers', () => {
    const listener1 = mock.fn();
    const listener2 = mock.fn();
    const store = createStore({ count: 0 });
    store.subscribe(listener1);
    store.subscribe(listener2);

    store.setState((s) => ({ ...s, count: 1 }));
    assert.strictEqual(listener1.mock.callCount(), 1);
    assert.strictEqual(listener2.mock.callCount(), 1);
  });

  it('sequential setState calls accumulate correctly', () => {
    const store = createStore({ count: 0 });

    store.setState((s) => ({ ...s, count: s.count + 1 }));
    store.setState((s) => ({ ...s, count: s.count + 1 }));
    store.setState((s) => ({ ...s, count: s.count + 1 }));

    assert.deepStrictEqual(store.getState(), { count: 3 });
  });
});
