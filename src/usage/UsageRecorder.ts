/**
 * Request-level usage recording.
 *
 * Captures token counts from every model API response, computes estimated cost
 * using the pricing registry, and emits structured ModelUsageRecord objects.
 */

import type { TokenUsage } from '../models/ModelClient.js';
import { getCostEstimate } from './pricing.js';
import type { ModelUsageRecord } from './types.js';

export interface UsageRecorderOptions {
  provider: string;
  model: string;
  conversationId: string;
  requestId: string;
  creatorId?: string;
  executionContext?: 'main' | 'background';
}

export type UsageListener = (record: ModelUsageRecord) => void;

/**
 * Records usage for model API calls within a single turn.
 *
 * Create one per turn execution. Call `record()` after each model API response.
 * Listeners receive structured usage records for downstream consumption
 * (event emission, quota tracking, analytics).
 */
export class UsageRecorder {
  private readonly listeners: UsageListener[] = [];
  private readonly records: ModelUsageRecord[] = [];
  private turnNumber = 0;
  private toolCallCount = 0;

  constructor(private readonly options: UsageRecorderOptions) {}

  /** Register a listener that receives every usage record as it's created. */
  onRecord(listener: UsageListener): void {
    this.listeners.push(listener);
  }

  /** Set current turn number (iteration index). */
  setTurnNumber(turn: number): void {
    this.turnNumber = turn;
  }

  /** Set current tool call count. */
  setToolCallCount(count: number): void {
    this.toolCallCount = count;
  }

  /**
   * Record usage from a model API response.
   *
   * @param tokenUsage - Token counts from the model response
   * @param context - Additional context about this call
   * @returns The created ModelUsageRecord, or undefined if no token usage provided
   */
  record(
    tokenUsage: TokenUsage | undefined,
    context?: {
      provider?: string;
      model?: string;
      isRetry?: boolean;
      isFallback?: boolean;
    },
  ): ModelUsageRecord | undefined {
    if (!tokenUsage) return undefined;

    const provider = context?.provider ?? this.options.provider;
    const model = context?.model ?? this.options.model;
    const estimatedCostUsd = getCostEstimate(
      provider,
      model,
      tokenUsage.inputTokens,
      tokenUsage.outputTokens,
      tokenUsage.cacheReadTokens ?? 0,
      tokenUsage.cacheWriteTokens ?? 0,
    );

    const record: ModelUsageRecord = {
      requestId: this.options.requestId,
      conversationId: this.options.conversationId,
      creatorId: this.options.creatorId,
      timestamp: Date.now(),
      provider,
      model,
      executionContext: this.options.executionContext ?? 'main',
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      cacheReadTokens: tokenUsage.cacheReadTokens,
      cacheWriteTokens: tokenUsage.cacheWriteTokens,
      thinkingTokens: tokenUsage.thinkingTokens,
      estimatedCostUsd,
      turnNumber: this.turnNumber,
      toolCallCount: this.toolCallCount,
      isRetry: context?.isRetry ?? false,
      isFallback: context?.isFallback ?? false,
    };

    this.records.push(record);

    for (const listener of this.listeners) {
      listener(record);
    }

    return record;
  }

  /** Get all usage records captured during this turn. */
  getRecords(): readonly ModelUsageRecord[] {
    return this.records;
  }

  /** Total estimated cost across all recorded calls. */
  getTotalCost(): number {
    let total = 0;
    for (const r of this.records) {
      total += r.estimatedCostUsd;
    }
    return total;
  }

  /** Total tokens across all recorded calls. */
  getTotalTokens(): { input: number; output: number; total: number } {
    let input = 0;
    let output = 0;
    for (const r of this.records) {
      input += r.inputTokens;
      output += r.outputTokens;
    }
    return { input, output, total: input + output };
  }
}
