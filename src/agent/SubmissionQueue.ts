import type { AgentConfig } from '../config/schema.js';
import { AgentRequestError } from './errors.js';
import type { AgentEvent, TurnSubmission } from './types.js';
import { EventQueue } from './EventQueue.js';
import type { ProcessStore } from './ProcessRuntimeState.js';

export class SubmissionQueue {
  private readonly activeConversations = new Set<string>();
  private readonly pendingByConversation = new Map<string, Array<() => Promise<void>>>();
  private activeCount = 0;

  constructor(
    private readonly config: AgentConfig,
    private readonly processStore?: ProcessStore,
  ) {}

  submit(
    submission: TurnSubmission,
    run: (events: EventQueue<AgentEvent>) => Promise<void>,
    onComplete?: (failed: boolean) => void,
  ): EventQueue<AgentEvent> {
    if (this.processStore?.getState().draining) {
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
      this.syncStoreStats();
      void execute();
    } else {
      const pending = this.pendingByConversation.get(submission.conversationId) ?? [];
      if (pending.length >= this.config.limits.max_pending) {
        throw new AgentRequestError('queue_full', 429);
      }
      pending.push(execute);
      this.pendingByConversation.set(submission.conversationId, pending);
      this.syncStoreStats();
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
      this.syncStoreStats();
      return;
    }
    if (pending!.length === 0) {
      this.pendingByConversation.delete(conversationId);
    }
    this.syncStoreStats();
    void next();
  }

  private syncStoreStats() {
    if (!this.processStore) {
      return;
    }
    let pendingCount = 0;
    for (const pending of this.pendingByConversation.values()) {
      pendingCount += pending.length;
    }
    const activeConversationCount = this.activeConversations.size;
    this.processStore.setState((s) => ({
      ...s,
      activeConversationCount,
      pendingSubmissionCount: pendingCount,
    }));
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
      draining: this.processStore?.getState().draining ?? false,
    };
  }

  beginDrain() {
    // Draining is now set via processStore.setState in Agent.beginDrain()
    // This method exists for backward compatibility with tests that call it directly
    this.processStore?.setState((s) => ({ ...s, draining: true }));
  }

  isDraining() {
    return this.processStore?.getState().draining ?? false;
  }
}
