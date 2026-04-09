import type { ProcessRuntimeState } from './ProcessRuntimeState.js';

/**
 * Listener callback types for specific state change events.
 * Side effects register through these listeners rather than importing
 * implementations directly, keeping the observer layer testable.
 */
export interface RuntimeListeners {
  onDrainingChanged?: (draining: boolean) => void;
  onActiveRequestCountChanged?: (count: number) => void;
  onActiveSessionCountChanged?: (sessionCount: number, turnCount: number) => void;
  onQueuePressureChanged?: (activeConversations: number, pending: number) => void;
}

/**
 * Creates the observer function that reacts to ProcessRuntimeState changes.
 * Uses explicit field-diff if-checks — not an event bus or generic diffing.
 *
 * Side effects call through registered listeners so the observer is testable
 * without standing up real external dependencies.
 */
export function createRuntimeObservers(listeners: RuntimeListeners = {}) {
  function onRuntimeStateChange(
    oldState: ProcessRuntimeState,
    newState: ProcessRuntimeState,
  ): void {
    if (oldState.draining !== newState.draining) {
      listeners.onDrainingChanged?.(newState.draining);
    }

    if (oldState.activeRequestCount !== newState.activeRequestCount) {
      listeners.onActiveRequestCountChanged?.(newState.activeRequestCount);
    }

    if (
      oldState.activeSessionCount !== newState.activeSessionCount
      || oldState.activeTurnCount !== newState.activeTurnCount
    ) {
      listeners.onActiveSessionCountChanged?.(
        newState.activeSessionCount,
        newState.activeTurnCount,
      );
    }

    if (
      oldState.activeConversationCount !== newState.activeConversationCount
      || oldState.pendingSubmissionCount !== newState.pendingSubmissionCount
    ) {
      listeners.onQueuePressureChanged?.(
        newState.activeConversationCount,
        newState.pendingSubmissionCount,
      );
    }
  }

  return { onRuntimeStateChange };
}
