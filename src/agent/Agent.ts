import type { AgentConfig } from '../config/schema.js';
import { AgentRequestError } from './errors.js';
import { SessionManager } from './SessionManager.js';
import { SubmissionQueue } from './SubmissionQueue.js';
import { createStore, type Store } from './RuntimeStore.js';
import { initialProcessRuntimeState, type ProcessRuntimeState } from './ProcessRuntimeState.js';
import { createRuntimeObservers, type RuntimeListeners } from './RuntimeObservers.js';
import type { AgentEvent } from './types.js';
import type { TurnSubmission } from './types.js';
import type { EventQueue } from './EventQueue.js';
import type { UsageAggregator } from '../usage/UsageAggregator.js';
import type { UsageSnapshot } from '../usage/types.js';

interface AgentDeps {
  queueFactory?: (getState: () => ProcessRuntimeState) => SubmissionQueue;
  sessionManager?: Pick<SessionManager, 'execute' | 'getStats' | 'beginDrain'> & { usageAggregator?: UsageAggregator };
  runtimeListeners?: RuntimeListeners;
}

export class Agent {
  private readonly store: Store<ProcessRuntimeState>;
  private readonly queue: SubmissionQueue;
  private readonly executor: {
    execute(submission: TurnSubmission, events: EventQueue<AgentEvent>): Promise<void>;
    getStats?: () => Record<string, unknown>;
    beginDrain?: () => void;
  };
  private readonly activeRequests = new Set<string>();
  private completedRequests = 0;
  private failedRequests = 0;

  constructor(private readonly config: AgentConfig, deps: AgentDeps = {}) {
    this.store = createStore(
      initialProcessRuntimeState(),
      createRuntimeObservers(deps.runtimeListeners),
    );
    this.queue = deps.queueFactory
      ? deps.queueFactory(this.store.getState)
      : new SubmissionQueue(config, this.store.getState);
    this.executor = deps.sessionManager ?? new SessionManager(config, { getState: this.store.getState });
  }

  submit(submission: TurnSubmission) {
    if (this.store.getState().draining) {
      throw new AgentRequestError('shutting_down', 503);
    }

    if (this.activeRequests.has(submission.requestId)) {
      throw new AgentRequestError('request_in_progress', 409);
    }

    this.activeRequests.add(submission.requestId);
    let events: EventQueue<AgentEvent>;
    try {
      events = this.queue.submit(
        submission,
        async (eventQueue) => {
          await this.executor.execute(submission, eventQueue);
        },
        (failed) => {
          this.activeRequests.delete(submission.requestId);
          this.store.setState(prev => ({ ...prev, activeRequestCount: prev.activeRequestCount - 1 }));
          if (failed) {
            this.failedRequests += 1;
          } else {
            this.completedRequests += 1;
          }
        },
      );
    } catch (e) {
      this.activeRequests.delete(submission.requestId);
      throw e;
    }
    this.store.setState(prev => ({ ...prev, activeRequestCount: prev.activeRequestCount + 1 }));
    return events;
  }

  getHealth() {
    const queueStats = this.queue.getStats();
    const { draining, activeRequestCount } = this.store.getState();
    return {
      model_provider: this.config.model.provider,
      active_requests: activeRequestCount,
      completed_requests: this.completedRequests,
      failed_requests: this.failedRequests,
      queue: queueStats,
      sessions: this.executor.getStats?.(),
      draining,
    };
  }

  beginDrain() {
    this.store.setState(prev => ({ ...prev, draining: true }));
    this.executor.beginDrain?.();
  }

  /** Get usage snapshot for reporting/billing. */
  getUsageSnapshot(since?: number): UsageSnapshot | undefined {
    return (this.executor as { usageAggregator?: UsageAggregator }).usageAggregator?.snapshot(since);
  }
}
