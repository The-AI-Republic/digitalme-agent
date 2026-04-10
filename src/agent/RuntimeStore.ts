export interface Store<T> {
  getState: () => T;
  setState: (updater: (prev: T) => T) => void;
}

export function createStore<T>(
  initialState: T,
  onChange?: (oldState: T, newState: T) => void,
): Store<T> {
  let state = initialState;

  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state;
      const next = updater(prev);
      if (Object.is(prev, next)) return;
      state = next;
      onChange?.(prev, next);
    },
  };
}
