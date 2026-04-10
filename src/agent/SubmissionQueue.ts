import type { AgentConfig } from '../config/schema.js';
import { AgentRequestError } from './errors.js';
import type { ProcessRuntimeState } from './ProcessRuntimeState.js';
import type { AgentEvent, TurnSubmission } from './types.js';
import { EventQueue } from './EventQueue.js';

export class SubmissionQueue {
  private readonly activeConversations = new Set<string>();
  private readonly pendingByConversation = new Map<string, Array<() => Promise<void>>>();
  private activeCount = 0;
  private readonly getProcessState: () => ProcessRuntimeState;

  constructor(
    private readonly config: AgentConfig,
    getState: () => ProcessRuntimeState,
  ) {
    this.getProcessState = getState;
  }

  submit(
    submission: TurnSubmission,
    run: (events: EventQueue<AgentEvent>) => Promise<void>,
    onComplete?: (failed: boolean) => void,
  ): EventQueue<AgentEvent> {
    if (this.getProcessState().draining) {
      throw new AgentRequestError('shutting_down', 503);
    }

    const isNewConversation = !this.activeConversations.has(submission.conversationId);
    if (this.activeCount >= this.config.limits.max_concurrent && isNewConversation) {
      throw new AgentRequestError('queue_full', 429);
    }

    const events = new EventQueue<AgentEvent>();

    const execute = async () => {
      let failed = false;
      try {
        await run(events);
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        events.push({ type: 'error', message });
      } finally {
        events.close();
        onComplete?.(failed);
        this.startNext(submission.conversationId);
      }
    };

    if (isNewConversation) {
      this.activeConversations.add(submission.conversationId);
      this.activeCount += 1;
      void execute();
    } else {
      const pending = this.pendingByConversation.get(submission.conversationId) ?? [];
      if (pending.length >= this.config.limits.max_pending) {
        throw new AgentRequestError('queue_full', 429);
      }
      pending.push(execute);
      this.pendingByConversation.set(submission.conversationId, pending);
    }

    return events;
  }

  private startNext(conversationId: string) {
    const pending = this.pendingByConversation.get(conversationId);
    const next = pending?.shift();
    if (!next) {
      this.pendingByConversation.delete(conversationId);
      this.activeConversations.delete(conversationId);
      this.activeCount = Math.max(0, this.activeCount - 1);
      return;
    }
    if (pending!.length === 0) {
      this.pendingByConversation.delete(conversationId);
    }
    void next();
  }

  getStats() {
    let pendingCount = 0;
    for (const pending of this.pendingByConversation.values()) {
      pendingCount += pending.length;
    }

    return {
      activeCount: this.activeCount,
      activeConversations: this.activeConversations.size,
      pendingCount,
    };
  }
}
