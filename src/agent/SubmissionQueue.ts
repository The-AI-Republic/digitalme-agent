import type { AgentConfig } from '../config/schema.js';
import { AgentRequestError } from './errors.js';
import type { AgentEvent, TurnSubmission } from './types.js';
import { EventQueue } from './EventQueue.js';

export class SubmissionQueue {
  private readonly activeConversations = new Set<string>();
  private readonly pendingByConversation = new Map<string, Array<() => Promise<void>>>();
  private activeCount = 0;
  private draining = false;

  constructor(private readonly config: AgentConfig) {}

  submit(submission: TurnSubmission, run: (events: EventQueue<AgentEvent>) => Promise<void>): EventQueue<AgentEvent> {
    if (this.draining) {
      throw new AgentRequestError('shutting_down', 503);
    }

    if (this.activeCount >= this.config.limits.max_concurrent && !this.activeConversations.has(submission.conversationId)) {
      throw new AgentRequestError('queue_full', 429);
    }

    const events = new EventQueue<AgentEvent>();
    const execute = async () => {
      this.activeConversations.add(submission.conversationId);
      this.activeCount += 1;
      try {
        await run(events);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        events.push({ type: 'error', message });
      } finally {
        events.close();
        this.activeConversations.delete(submission.conversationId);
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.startNext(submission.conversationId);
      }
    };

    if (this.activeConversations.has(submission.conversationId)) {
      const pending = this.pendingByConversation.get(submission.conversationId) ?? [];
      if (pending.length >= this.config.limits.max_pending) {
        throw new AgentRequestError('queue_full', 429);
      }
      pending.push(execute);
      this.pendingByConversation.set(submission.conversationId, pending);
    } else {
      void execute();
    }

    return events;
  }

  private startNext(conversationId: string) {
    const pending = this.pendingByConversation.get(conversationId);
    if (!pending || pending.length === 0) {
      this.pendingByConversation.delete(conversationId);
      return;
    }
    const next = pending.shift();
    if (!next) {
      this.pendingByConversation.delete(conversationId);
      return;
    }
    if (pending.length === 0) {
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
      draining: this.draining,
    };
  }

  beginDrain() {
    this.draining = true;
  }

  isDraining() {
    return this.draining;
  }
}
