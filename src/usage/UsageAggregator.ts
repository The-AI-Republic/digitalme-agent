/**
 * Process-level usage aggregation.
 *
 * Collects ConversationUsage snapshots from all active and completed sessions,
 * provides daily/monthly cost aggregates for quota enforcement, and exposes
 * usage reports for the platform.
 */

import type { ConversationUsage, ModelUsageRecord, UsageSnapshot } from './types.js';

const USD_PRECISION = 1_000_000;

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * USD_PRECISION) / USD_PRECISION;
}

interface DailyBucket {
  date: string; // YYYY-MM-DD
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  conversations: Set<string>;
}

/**
 * In-memory usage aggregator. Tracks per-conversation and per-day usage.
 *
 * Not persisted — resets on process restart. Sufficient for quota enforcement
 * during a single process lifecycle. For durable billing, the platform
 * should aggregate from usage events or transcript records.
 */
export class UsageAggregator {
  private readonly conversations = new Map<string, ConversationUsage>();
  private readonly dailyBuckets = new Map<string, DailyBucket>();

  /** Update the stored snapshot for a conversation. */
  updateConversation(usage: ConversationUsage): void {
    this.conversations.set(usage.conversationId, usage);
  }

  /** Record a single model usage record into daily aggregates. */
  recordUsage(record: ModelUsageRecord): void {
    const date = new Date(record.timestamp).toISOString().slice(0, 10);
    let bucket = this.dailyBuckets.get(date);
    if (!bucket) {
      bucket = {
        date,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        conversations: new Set(),
      };
      this.dailyBuckets.set(date, bucket);
    }
    bucket.totalCostUsd = roundUsd(bucket.totalCostUsd + record.estimatedCostUsd);
    bucket.totalInputTokens += record.inputTokens;
    bucket.totalOutputTokens += record.outputTokens;
    bucket.conversations.add(record.conversationId);
  }

  /** Remove a conversation from tracking (e.g. on session eviction). */
  removeConversation(conversationId: string): void {
    this.conversations.delete(conversationId);
  }

  /** Get total cost for today. */
  getDailyCost(date?: string): number {
    const key = date ?? new Date().toISOString().slice(0, 10);
    return this.dailyBuckets.get(key)?.totalCostUsd ?? 0;
  }

  /** Get total cost for the current month. */
  getMonthlyCost(yearMonth?: string): number {
    const prefix = yearMonth ?? new Date().toISOString().slice(0, 7);
    let total = 0;
    for (const [date, bucket] of this.dailyBuckets) {
      if (date.startsWith(prefix)) {
        total = roundUsd(total + bucket.totalCostUsd);
      }
    }
    return total;
  }

  /** Get usage for a specific conversation. */
  getConversationUsage(conversationId: string): ConversationUsage | undefined {
    return this.conversations.get(conversationId);
  }

  /** Total process-level cost across all conversations. */
  getTotalCost(): number {
    let total = 0;
    for (const usage of this.conversations.values()) {
      total = roundUsd(total + usage.totalEstimatedCostUsd);
    }
    return total;
  }

  /** Produce a snapshot for the usage reporting endpoint. */
  snapshot(since?: number): UsageSnapshot {
    const now = Date.now();
    const start = since ?? 0;

    const conversations: UsageSnapshot['conversations'] = [];
    let totalCostUsd = 0;
    let totalInput = 0;
    let totalOutput = 0;

    for (const usage of this.conversations.values()) {
      if (usage.startedAt >= start || usage.lastUpdatedAt >= start) {
        conversations.push({
          conversationId: usage.conversationId,
          totalCostUsd: usage.totalEstimatedCostUsd,
          modelCallCount: usage.modelCallCount,
          turnCount: usage.turnCount,
        });
        totalCostUsd = roundUsd(totalCostUsd + usage.totalEstimatedCostUsd);
        totalInput += usage.totalInputTokens;
        totalOutput += usage.totalOutputTokens;
      }
    }

    return {
      period: { start, end: now },
      totalCostUsd,
      totalTokens: { input: totalInput, output: totalOutput },
      conversationCount: conversations.length,
      avgCostPerConversation: conversations.length > 0
        ? totalCostUsd / conversations.length
        : 0,
      conversations,
    };
  }

  /** Prune daily buckets older than the given number of days. */
  pruneOldBuckets(retainDays: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retainDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    let pruned = 0;
    for (const [date] of this.dailyBuckets) {
      if (date < cutoffStr) {
        this.dailyBuckets.delete(date);
        pruned++;
      }
    }
    return pruned;
  }
}
