import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeObservers, type RuntimeListeners } from './RuntimeObservers.js';
import { createStore } from './RuntimeStore.js';
import { initialProcessRuntimeState, type ProcessRuntimeState } from './ProcessRuntimeState.js';

test('observer fires onActiveRequestCountChanged when count changes', () => {
  const changes: Array<[number, number]> = [];
  const listeners: RuntimeListeners = {
    onActiveRequestCountChanged: (oldCount, newCount) => {
      changes.push([oldCount, newCount]);
    },
  };

  const store = createStore(initialProcessRuntimeState(), createRuntimeObservers(listeners));
  store.setState(prev => ({ ...prev, activeRequestCount: 1 }));
  store.setState(prev => ({ ...prev, activeRequestCount: 2 }));

  assert.deepEqual(changes, [[0, 1], [1, 2]]);
});

test('observer fires onDrainingChanged when draining changes', () => {
  const changes: boolean[] = [];
  const listeners: RuntimeListeners = {
    onDrainingChanged: (draining) => {
      changes.push(draining);
    },
  };

  const store = createStore(initialProcessRuntimeState(), createRuntimeObservers(listeners));
  store.setState(prev => ({ ...prev, draining: true }));

  assert.deepEqual(changes, [true]);
});

test('observer does not fire when fields are unchanged', () => {
  let callCount = 0;
  const listeners: RuntimeListeners = {
    onActiveRequestCountChanged: () => { callCount += 1; },
    onDrainingChanged: () => { callCount += 1; },
  };

  const store = createStore(initialProcessRuntimeState(), createRuntimeObservers(listeners));

  // Change only draining — activeRequestCount listener should not fire
  store.setState(prev => ({ ...prev, draining: true }));
  assert.equal(callCount, 1); // only onDrainingChanged

  // Change only activeRequestCount — draining listener should not fire
  store.setState(prev => ({ ...prev, activeRequestCount: 5 }));
  assert.equal(callCount, 2); // only onActiveRequestCountChanged
});

test('observer works with no listeners registered', () => {
  const onChange = createRuntimeObservers();
  const store = createStore(initialProcessRuntimeState(), onChange);

  // Should not throw
  store.setState(prev => ({ ...prev, activeRequestCount: 1 }));
  store.setState(prev => ({ ...prev, draining: true }));
  assert.equal(store.getState().activeRequestCount, 1);
  assert.equal(store.getState().draining, true);
});

test('observer works with empty listeners object', () => {
  const onChange = createRuntimeObservers({});
  const store = createStore(initialProcessRuntimeState(), onChange);

  // Should not throw
  store.setState(prev => ({ ...prev, activeRequestCount: 3 }));
  assert.equal(store.getState().activeRequestCount, 3);
});

test('no duplicate side effects on identical state', () => {
  let callCount = 0;
  const listeners: RuntimeListeners = {
    onActiveRequestCountChanged: () => { callCount += 1; },
    onDrainingChanged: () => { callCount += 1; },
  };

  const store = createStore(initialProcessRuntimeState(), createRuntimeObservers(listeners));

  // Set state to a new object but with same values — Object.is short-circuit won't fire because
  // the store's Object.is check compares references, so onChange WILL fire, but the observer's
  // field-diff checks will skip because values are the same
  const currentState = store.getState();
  const onChange = createRuntimeObservers(listeners);
  onChange(currentState, { ...currentState }); // Same values, different reference
  assert.equal(callCount, 0); // No field actually changed
});

test('observer handles both fields changing in single setState', () => {
  const requestChanges: Array<[number, number]> = [];
  const drainingChanges: boolean[] = [];
  const listeners: RuntimeListeners = {
    onActiveRequestCountChanged: (oldCount, newCount) => {
      requestChanges.push([oldCount, newCount]);
    },
    onDrainingChanged: (draining) => {
      drainingChanges.push(draining);
    },
  };

  const store = createStore(initialProcessRuntimeState(), createRuntimeObservers(listeners));
  store.setState(() => ({ activeRequestCount: 5, draining: true }));

  assert.deepEqual(requestChanges, [[0, 5]]);
  assert.deepEqual(drainingChanges, [true]);
});
