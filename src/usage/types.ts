/**
 * Usage tracking types for per-request and per-conversation cost accounting.
 */

/** A single model API call usage record. */
export interface ModelUsageRecord {
  requestId: string;
  conversationId: string;
  creatorId?: string;
  timestamp: number;

  // Model details
  provider: string;
  model: string;
  executionContext: 'main' | 'background';

  // Token counts
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;

  // Cost (computed from token counts + pricing)
  estimatedCostUsd: number;

  // Context
  turnNumber: number;
  toolCallCount: number;
  isRetry: boolean;
  isFallback: boolean;
}

/** Accumulated usage for a conversation. */
export interface ConversationUsage {
  conversationId: string;
  creatorId?: string;
  startedAt: number;
  lastUpdatedAt: number;

  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;

  turnCount: number;
  modelCallCount: number;
  toolCallCount: number;

  // Breakdown by execution context
  mainConversationCost: number;
  backgroundWorkCost: number;

  // Breakdown by model
  costByModel: Record<string, number>;
}

/** Quota limits for a creator. */
export interface CreatorQuota {
  /** Max USD spend per conversation. */
  maxCostPerConversation?: number;
  /** Max USD spend per day across all conversations. */
  maxCostPerDay?: number;
  /** Max USD spend per month. */
  maxCostPerMonth?: number;
  /** Max total tokens per conversation. */
  maxTokensPerConversation?: number;
  /** Max turns per conversation. */
  maxTurnsPerConversation?: number;
}

/** Result of a quota check before a model call. */
export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  remainingBudget?: number;
  suggestedAction?: 'proceed' | 'downgrade_model' | 'refuse';
}

/** Agent event extension for usage tracking. */
export interface UsageEvent {
  type: 'usage';
  record: ModelUsageRecord;
}

/** Agent event extension for quota warnings. */
export interface QuotaWarningEvent {
  type: 'quota_warning';
  quotaType: string;
  currentUsage: number;
  limit: number;
  percentUsed: number;
}

/** Snapshot of usage data for reporting. */
export interface UsageSnapshot {
  period: { start: number; end: number };
  totalCostUsd: number;
  totalTokens: { input: number; output: number };
  conversationCount: number;
  avgCostPerConversation: number;
  conversations: Array<{
    conversationId: string;
    totalCostUsd: number;
    modelCallCount: number;
    turnCount: number;
  }>;
}
