import type { AgentConfig } from '../config/schema.js';
import { AgentRequestError } from './errors.js';
import { SessionManager } from './SessionManager.js';
import { SubmissionQueue } from './SubmissionQueue.js';
import { ShutdownController } from './shutdown.js';
import type { AgentEvent } from './types.js';
import type { TurnSubmission } from './types.js';
import type { EventQueue } from './EventQueue.js';

interface AgentDeps {
  queue?: SubmissionQueue;
  sessionManager?: Pick<SessionManager, 'execute' | 'getStats' | 'beginDrain'>;
}

export class Agent {
  private readonly queue: SubmissionQueue;
  private readonly executor: {
    execute(submission: TurnSubmission, events: EventQueue<AgentEvent>): Promise<void>;
    getStats?: () => Record<string, unknown>;
    beginDrain?: () => void;
  };
  private readonly shutdown = new ShutdownController();
  private readonly activeRequests = new Set<string>();
  private completedRequests = 0;
  private failedRequests = 0;

  constructor(private readonly config: AgentConfig, deps: AgentDeps = {}) {
    this.queue = deps.queue ?? new SubmissionQueue(config);
    this.executor = deps.sessionManager ?? new SessionManager(config);
  }

  submit(submission: TurnSubmission) {
    if (this.shutdown.isDraining()) {
      throw new AgentRequestError('shutting_down', 503);
    }

    if (this.activeRequests.has(submission.requestId)) {
      throw new AgentRequestError('request_in_progress', 409);
    }

    this.activeRequests.add(submission.requestId);
    return this.queue.submit(
      submission,
      async (events) => {
        await this.executor.execute(submission, events);
      },
      (failed) => {
        this.activeRequests.delete(submission.requestId);
        if (failed) {
          this.failedRequests += 1;
        } else {
          this.completedRequests += 1;
        }
      },
    );
  }

  getHealth() {
    const queueStats = this.queue.getStats();
    return {
      model_provider: this.config.model.provider,
      active_requests: this.activeRequests.size,
      completed_requests: this.completedRequests,
      failed_requests: this.failedRequests,
      queue: queueStats,
      sessions: this.executor.getStats?.(),
      draining: this.shutdown.isDraining(),
    };
  }

  beginDrain() {
    this.shutdown.beginDrain();
    this.queue.beginDrain();
    this.executor.beginDrain?.();
  }
}
