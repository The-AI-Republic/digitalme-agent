import type { ProcessRuntimeState } from './ProcessRuntimeState.js';

export interface RuntimeListeners {
  onActiveRequestCountChanged?: (oldCount: number, newCount: number) => void;
  onDrainingChanged?: (draining: boolean) => void;
}

export function createRuntimeObservers(
  listeners?: RuntimeListeners,
): (oldState: ProcessRuntimeState, newState: ProcessRuntimeState) => void {
  return (oldState, newState) => {
    if (oldState.activeRequestCount !== newState.activeRequestCount) {
      listeners?.onActiveRequestCountChanged?.(oldState.activeRequestCount, newState.activeRequestCount);
    }
    if (oldState.draining !== newState.draining) {
      listeners?.onDrainingChanged?.(newState.draining);
    }
  };
}
