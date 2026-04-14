/**
 * Cost-aware model routing.
 *
 * Uses quota pressure from ConversationUsageTracker and QuotaEnforcer to
 * influence model selection decisions:
 *
 * - Approaching limits → prefer fallback/cheaper model
 * - Approaching limits → signal compaction should be more aggressive
 * - Exceeded → refuse with graceful message
 */

import type { ConversationUsage, CreatorQuota, QuotaCheckResult } from './types.js';
import { QuotaEnforcer, type QuotaEnforcerConfig } from './QuotaEnforcer.js';

export interface CostAwareRoutingDecision {
  /** Whether the request should proceed. */
  allowed: boolean;
  /** If not allowed, the refusal message. */
  refusalMessage?: string;
  /** Whether to use the fallback (cheaper) model instead of primary. */
  useFallbackModel: boolean;
  /** Whether context compaction should be more aggressive. */
  increaseCompaction: boolean;
  /** The quota check result that drove this decision. */
  quotaResult: QuotaCheckResult;
}

export interface CostAwareRouterConfig {
  /** Quota enforcer config (quota limits, thresholds, etc). */
  quotaConfig?: QuotaEnforcerConfig;
  /** Ratio of cost limit at which to start preferring fallback model. */
  fallbackThreshold?: number;
  /** Ratio of cost limit at which to increase compaction aggressiveness. */
  compactionThreshold?: number;
}

/**
 * Makes routing decisions based on quota pressure.
 *
 * Sits between the session runtime and the turn executor, influencing
 * model selection and compaction parameters based on cost data.
 */
export class CostAwareRouter {
  private readonly enforcer?: QuotaEnforcer;
  private readonly fallbackThreshold: number;
  private readonly compactionThreshold: number;

  constructor(config: CostAwareRouterConfig) {
    if (config.quotaConfig) {
      this.enforcer = new QuotaEnforcer(config.quotaConfig);
    }
    this.fallbackThreshold = config.fallbackThreshold ?? 0.7;
    this.compactionThreshold = config.compactionThreshold ?? 0.5;
  }

  /**
   * Evaluate current usage against quotas and return a routing decision.
   */
  evaluate(
    conversationUsage: ConversationUsage,
    dailyCostUsd?: number,
    monthlyCostUsd?: number,
  ): CostAwareRoutingDecision {
    if (!this.enforcer) {
      return {
        allowed: true,
        useFallbackModel: false,
        increaseCompaction: false,
        quotaResult: { allowed: true, suggestedAction: 'proceed' },
      };
    }

    const quotaResult = this.enforcer.checkAll(conversationUsage, dailyCostUsd, monthlyCostUsd);

    if (!quotaResult.allowed) {
      return {
        allowed: false,
        refusalMessage: this.enforcer.getRefusalMessage(),
        useFallbackModel: false,
        increaseCompaction: false,
        quotaResult,
      };
    }

    const quota = this.enforcer.getQuota();
    const costRatio = this.getCostRatio(conversationUsage, quota);

    return {
      allowed: true,
      useFallbackModel: costRatio >= this.fallbackThreshold,
      increaseCompaction: costRatio >= this.compactionThreshold,
      quotaResult,
    };
  }

  /** Get the underlying quota enforcer, if configured. */
  getEnforcer(): QuotaEnforcer | undefined {
    return this.enforcer;
  }

  private getCostRatio(usage: ConversationUsage, quota: CreatorQuota): number {
    if (quota.maxCostPerConversation != null && quota.maxCostPerConversation > 0) {
      return usage.totalEstimatedCostUsd / quota.maxCostPerConversation;
    }
    return 0;
  }
}
