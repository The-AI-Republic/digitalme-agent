import { createStore, type RuntimeStore } from './RuntimeStore.js';

/**
 * Observable process-level state.
 * Single source of truth for draining, active counts, and queue pressure.
 * Replaces the four duplicated draining flags across Agent, ShutdownController,
 * SubmissionQueue, and SessionManager.
 */
export interface ProcessRuntimeState {
  /** Single source of truth for drain state — replaces four separate flags */
  draining: boolean;
  /** Active request count (replaces Agent.activeRequests.size) */
  activeRequestCount: number;
  /** Active conversation count (replaces SubmissionQueue.activeConversations.size) */
  activeConversationCount: number;
  /** Total pending submissions across all conversations */
  pendingSubmissionCount: number;
  /** Active session count (replaces SessionManager.sessions.size) */
  activeSessionCount: number;
  /** Active turn count (derived from SessionManager) */
  activeTurnCount: number;
}

/**
 * Cumulative counters and static identity — NOT observable, NOT in the store.
 * These only grow monotonically and don't drive side effects.
 */
export interface ProcessAccumulatorState {
  completedRequests: number;
  failedRequests: number;
  startedAt: string;
}

export function createInitialProcessState(): ProcessRuntimeState {
  return {
    draining: false,
    activeRequestCount: 0,
    activeConversationCount: 0,
    pendingSubmissionCount: 0,
    activeSessionCount: 0,
    activeTurnCount: 0,
  };
}

export function createProcessAccumulatorState(): ProcessAccumulatorState {
  return {
    completedRequests: 0,
    failedRequests: 0,
    startedAt: new Date().toISOString(),
  };
}

export type ProcessStore = RuntimeStore<ProcessRuntimeState>;

export function createProcessStore(
  onChange?: (oldState: ProcessRuntimeState, newState: ProcessRuntimeState) => void,
): ProcessStore {
  return createStore(createInitialProcessState(), onChange);
}

/**
 * Build a health snapshot from the store + accumulators.
 * Replaces the scattered Agent.getHealth() aggregation.
 */
export function buildHealthSnapshot(
  state: ProcessRuntimeState,
  accumulators: ProcessAccumulatorState,
  modelProvider: string,
): Record<string, unknown> {
  return {
    model_provider: modelProvider,
    active_requests: state.activeRequestCount,
    completed_requests: accumulators.completedRequests,
    failed_requests: accumulators.failedRequests,
    queue: {
      activeCount: state.activeConversationCount,
      activeConversations: state.activeConversationCount,
      pendingCount: state.pendingSubmissionCount,
      draining: state.draining,
    },
    sessions: {
      activeSessions: state.activeSessionCount,
      activeTurns: state.activeTurnCount,
    },
    draining: state.draining,
  };
}
