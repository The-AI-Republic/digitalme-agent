export interface RuntimeStore<T> {
  getState(): T;
  setState(updater: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(
  initialState: T,
  onChange?: (oldState: T, newState: T) => void,
): RuntimeStore<T> {
  let state = initialState;
  const listeners = new Set<() => void>();

  return {
    getState() {
      return state;
    },

    setState(updater: (prev: T) => T) {
      const next = updater(state);
      if (Object.is(next, state)) {
        return;
      }
      const prev = state;
      state = next;
      onChange?.(prev, next);
      for (const listener of listeners) {
        listener();
      }
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
