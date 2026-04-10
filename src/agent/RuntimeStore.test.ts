import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from './RuntimeStore.js';

test('createStore returns initial state via getState', () => {
  const store = createStore({ count: 0 });
  assert.deepEqual(store.getState(), { count: 0 });
});

test('setState updates state', () => {
  const store = createStore({ count: 0 });
  store.setState(prev => ({ ...prev, count: prev.count + 1 }));
  assert.deepEqual(store.getState(), { count: 1 });
});

test('onChange fires on state change', () => {
  const changes: Array<{ old: { count: number }; new: { count: number } }> = [];
  const store = createStore({ count: 0 }, (oldState, newState) => {
    changes.push({ old: oldState, new: newState });
  });

  store.setState(prev => ({ ...prev, count: 1 }));

  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]?.old, { count: 0 });
  assert.deepEqual(changes[0]?.new, { count: 1 });
});

test('Object.is short-circuit: onChange not called for identity-equal state', () => {
  let callCount = 0;
  const initial = { count: 0 };
  const store = createStore(initial, () => {
    callCount += 1;
  });

  // Return same reference — should not fire onChange
  store.setState(prev => prev);
  assert.equal(callCount, 0);
  assert.strictEqual(store.getState(), initial);
});

test('onChange fires for structurally equal but referentially different state', () => {
  let callCount = 0;
  const store = createStore({ count: 0 }, () => {
    callCount += 1;
  });

  // New object with same values — should fire onChange (not identity-equal)
  store.setState(prev => ({ ...prev }));
  assert.equal(callCount, 1);
});

test('multiple setState calls fire onChange for each non-identity change', () => {
  const counts: number[] = [];
  const store = createStore({ count: 0 }, (_old, newState) => {
    counts.push(newState.count);
  });

  store.setState(prev => ({ ...prev, count: 1 }));
  store.setState(prev => ({ ...prev, count: 2 }));
  store.setState(prev => ({ ...prev, count: 3 }));

  assert.deepEqual(counts, [1, 2, 3]);
});

test('store works without onChange callback', () => {
  const store = createStore({ value: 'hello' });
  store.setState(prev => ({ ...prev, value: 'world' }));
  assert.deepEqual(store.getState(), { value: 'world' });
});
