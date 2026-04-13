/**
 * Conversation-level usage accumulation.
 *
 * Accumulates ModelUsageRecords across turns into a ConversationUsage snapshot.
 * Tracks breakdowns by execution context and model.
 */

import type { ConversationUsage, ModelUsageRecord } from './types.js';

/**
 * Tracks cumulative usage for a single conversation.
 *
 * Designed to live alongside SessionState — one tracker per active session.
 * Thread-safe for single-conversation sequential access (Node.js event loop).
 */
export class ConversationUsageTracker {
  private readonly usage: ConversationUsage;

  constructor(conversationId: string, creatorId?: string) {
    const now = Date.now();
    this.usage = {
      conversationId,
      creatorId,
      startedAt: now,
      lastUpdatedAt: now,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCostUsd: 0,
      turnCount: 0,
      modelCallCount: 0,
      toolCallCount: 0,
      mainConversationCost: 0,
      backgroundWorkCost: 0,
      costByModel: {},
    };
  }

  /** Record a single model API call's usage. */
  addRecord(record: ModelUsageRecord): void {
    this.usage.lastUpdatedAt = Date.now();
    this.usage.totalInputTokens += record.inputTokens;
    this.usage.totalOutputTokens += record.outputTokens;
    this.usage.totalEstimatedCostUsd += record.estimatedCostUsd;
    this.usage.modelCallCount += 1;

    // Context breakdown
    if (record.executionContext === 'background') {
      this.usage.backgroundWorkCost += record.estimatedCostUsd;
    } else {
      this.usage.mainConversationCost += record.estimatedCostUsd;
    }

    // Model breakdown
    const modelKey = `${record.provider}:${record.model}`;
    this.usage.costByModel[modelKey] =
      (this.usage.costByModel[modelKey] ?? 0) + record.estimatedCostUsd;
  }

  /** Increment the turn counter (call once per turn start). */
  incrementTurnCount(): void {
    this.usage.turnCount += 1;
    this.usage.lastUpdatedAt = Date.now();
  }

  /** Update the tool call count from the execution state. */
  setToolCallCount(count: number): void {
    this.usage.toolCallCount = count;
    this.usage.lastUpdatedAt = Date.now();
  }

  /** Get the current accumulated usage snapshot. */
  getUsage(): Readonly<ConversationUsage> {
    return { ...this.usage, costByModel: { ...this.usage.costByModel } };
  }

  /** Total estimated cost in USD. */
  getTotalCost(): number {
    return this.usage.totalEstimatedCostUsd;
  }

  /** Total tokens consumed. */
  getTotalTokens(): number {
    return this.usage.totalInputTokens + this.usage.totalOutputTokens;
  }

  /** Number of completed turns. */
  getTurnCount(): number {
    return this.usage.turnCount;
  }

  /**
   * Restore usage state from a persisted snapshot (cold-start restoration).
   */
  restore(snapshot: ConversationUsage): void {
    Object.assign(this.usage, snapshot);
  }

  /**
   * Produce a serializable snapshot for persistence.
   */
  snapshot(): ConversationUsage {
    return this.getUsage();
  }
}
