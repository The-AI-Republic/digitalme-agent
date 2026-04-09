import type { AgentConfig } from '../config/schema.js';
import { AgentRequestError } from './errors.js';
import { SessionManager } from './SessionManager.js';
import { SubmissionQueue } from './SubmissionQueue.js';
import type { AgentEvent } from './types.js';
import type { TurnSubmission } from './types.js';
import type { EventQueue } from './EventQueue.js';
import {
  createProcessStore,
  createProcessAccumulatorState,
  buildHealthSnapshot,
  type ProcessStore,
  type ProcessAccumulatorState,
} from './ProcessRuntimeState.js';
import { createRuntimeObservers } from './RuntimeObservers.js';

interface AgentDeps {
  queue?: SubmissionQueue;
  sessionManager?: Pick<SessionManager, 'execute' | 'getStats' | 'beginDrain'>;
  processStore?: ProcessStore;
}

export class Agent {
  private readonly queue: SubmissionQueue;
  private readonly executor: {
    execute(submission: TurnSubmission, events: EventQueue<AgentEvent>): Promise<void>;
    getStats?: () => Record<string, unknown>;
    beginDrain?: () => void;
  };
  readonly processStore: ProcessStore;
  private readonly accumulators: ProcessAccumulatorState;
  private readonly activeRequests = new Set<string>();

  constructor(private readonly config: AgentConfig, deps: AgentDeps = {}) {
    const observers = createRuntimeObservers();
    this.processStore = deps.processStore ?? createProcessStore(observers.onRuntimeStateChange);
    this.accumulators = createProcessAccumulatorState();
    this.queue = deps.queue ?? new SubmissionQueue(config, this.processStore);
    this.executor = deps.sessionManager ?? new SessionManager(config);
  }

  submit(submission: TurnSubmission) {
    if (this.processStore.getState().draining) {
      throw new AgentRequestError('shutting_down', 503);
    }

    if (this.activeRequests.has(submission.requestId)) {
      throw new AgentRequestError('request_in_progress', 409);
    }

    this.activeRequests.add(submission.requestId);
    this.processStore.setState((s) => ({
      ...s,
      activeRequestCount: s.activeRequestCount + 1,
    }));

    return this.queue.submit(
      submission,
      async (events) => {
        await this.executor.execute(submission, events);
      },
      (failed) => {
        this.activeRequests.delete(submission.requestId);
        this.processStore.setState((s) => ({
          ...s,
          activeRequestCount: s.activeRequestCount - 1,
        }));
        if (failed) {
          this.accumulators.failedRequests += 1;
        } else {
          this.accumulators.completedRequests += 1;
        }
      },
    );
  }

  getHealth() {
    return buildHealthSnapshot(
      this.processStore.getState(),
      this.accumulators,
      this.config.model.provider,
    );
  }

  beginDrain() {
    this.processStore.setState((s) => ({ ...s, draining: true }));
    this.queue.beginDrain();
    this.executor.beginDrain?.();
  }
}
