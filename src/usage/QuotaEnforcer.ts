/**
 * Quota enforcement for creator-level spending and usage limits.
 *
 * Performs pre-turn quota checks and emits warnings when approaching limits.
 * Integrates with ConversationUsageTracker for current usage data and with
 * the global UsageAggregator for cross-conversation daily/monthly limits.
 */

import type { ConversationUsage, CreatorQuota, QuotaCheckResult, QuotaWarningEvent } from './types.js';

/** Default threshold at which warnings are emitted (80%). */
const DEFAULT_WARNING_THRESHOLD = 0.8;

export interface QuotaEnforcerConfig {
  quota: CreatorQuota;
  warningThreshold?: number;
  /** Action to take when quota is exceeded. */
  onExceeded?: 'graceful_refuse' | 'downgrade_model' | 'silent_stop';
  /** Custom message for graceful refusal. */
  refusalMessage?: string;
}

export type QuotaWarningListener = (warning: QuotaWarningEvent) => void;

/**
 * Enforces creator-level quotas against current usage.
 *
 * Stateless — depends on external usage data passed to check methods.
 * This keeps it testable and decoupled from storage.
 */
export class QuotaEnforcer {
  private readonly quota: CreatorQuota;
  private readonly warningThreshold: number;
  private readonly onExceeded: string;
  private readonly refusalMessage: string;
  private readonly warningListeners: QuotaWarningListener[] = [];

  constructor(config: QuotaEnforcerConfig) {
    this.quota = config.quota;
    this.warningThreshold = config.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
    this.onExceeded = config.onExceeded ?? 'graceful_refuse';
    this.refusalMessage = config.refusalMessage ??
      'I\'ve reached the usage limit for this conversation. Please start a new conversation or contact the creator.';
  }

  /** Register a listener for quota warning events. */
  onWarning(listener: QuotaWarningListener): void {
    this.warningListeners.push(listener);
  }

  /**
   * Check whether a new turn is allowed given current conversation usage.
   *
   * This is the primary enforcement point — call before each turn.
   */
  checkConversation(usage: ConversationUsage): QuotaCheckResult {
    let mostUrgentAction: QuotaCheckResult['suggestedAction'] = 'proceed';

    // Check cost per conversation
    if (this.quota.maxCostPerConversation != null) {
      const result = this.checkLimit(
        'cost_per_conversation',
        usage.totalEstimatedCostUsd,
        this.quota.maxCostPerConversation,
      );
      if (!result.allowed) return result;
      if (result.suggestedAction === 'downgrade_model') mostUrgentAction = 'downgrade_model';
    }

    // Check tokens per conversation
    if (this.quota.maxTokensPerConversation != null) {
      const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;
      const result = this.checkLimit(
        'tokens_per_conversation',
        totalTokens,
        this.quota.maxTokensPerConversation,
      );
      if (!result.allowed) return result;
      if (result.suggestedAction === 'downgrade_model') mostUrgentAction = 'downgrade_model';
    }

    // Check turns per conversation
    if (this.quota.maxTurnsPerConversation != null) {
      const result = this.checkLimit(
        'turns_per_conversation',
        usage.turnCount,
        this.quota.maxTurnsPerConversation,
      );
      if (!result.allowed) return result;
      if (result.suggestedAction === 'downgrade_model') mostUrgentAction = 'downgrade_model';
    }

    return { allowed: true, suggestedAction: mostUrgentAction };
  }

  /**
   * Check daily quota against aggregated daily cost.
   */
  checkDaily(dailyCostUsd: number): QuotaCheckResult {
    if (this.quota.maxCostPerDay == null) {
      return { allowed: true, suggestedAction: 'proceed' };
    }
    return this.checkLimit('cost_per_day', dailyCostUsd, this.quota.maxCostPerDay);
  }

  /**
   * Check monthly quota against aggregated monthly cost.
   */
  checkMonthly(monthlyCostUsd: number): QuotaCheckResult {
    if (this.quota.maxCostPerMonth == null) {
      return { allowed: true, suggestedAction: 'proceed' };
    }
    return this.checkLimit('cost_per_month', monthlyCostUsd, this.quota.maxCostPerMonth);
  }

  /**
   * Run all applicable quota checks. Returns the first failure, or allowed.
   */
  checkAll(
    conversationUsage: ConversationUsage,
    dailyCostUsd?: number,
    monthlyCostUsd?: number,
  ): QuotaCheckResult {
    const conversationResult = this.checkConversation(conversationUsage);
    if (!conversationResult.allowed) return conversationResult;

    if (dailyCostUsd != null) {
      const dailyResult = this.checkDaily(dailyCostUsd);
      if (!dailyResult.allowed) return dailyResult;
    }

    if (monthlyCostUsd != null) {
      const monthlyResult = this.checkMonthly(monthlyCostUsd);
      if (!monthlyResult.allowed) return monthlyResult;
    }

    return { allowed: true, suggestedAction: 'proceed' };
  }

  /** Get the configured refusal message. */
  getRefusalMessage(): string {
    return this.refusalMessage;
  }

  /** Get the configured exceeded action. */
  getOnExceededAction(): string {
    return this.onExceeded;
  }

  /** Get the quota configuration. */
  getQuota(): Readonly<CreatorQuota> {
    return { ...this.quota };
  }

  /**
   * Check whether usage is approaching a limit and should trigger model downgrade.
   * Returns true if usage is above warning threshold but below the limit.
   */
  shouldDowngradeModel(conversationUsage: ConversationUsage): boolean {
    if (this.onExceeded !== 'downgrade_model') return false;

    if (this.quota.maxCostPerConversation != null) {
      const ratio = conversationUsage.totalEstimatedCostUsd / this.quota.maxCostPerConversation;
      if (ratio >= this.warningThreshold && ratio < 1.0) return true;
    }

    return false;
  }

  private checkLimit(
    quotaType: string,
    currentUsage: number,
    limit: number,
  ): QuotaCheckResult {
    const ratio = currentUsage / limit;

    // Emit warning if approaching limit
    if (ratio >= this.warningThreshold && ratio < 1.0) {
      this.emitWarning({
        type: 'quota_warning',
        quotaType,
        currentUsage,
        limit,
        percentUsed: Math.round(ratio * 100),
      });
    }

    if (currentUsage >= limit) {
      const suggestedAction = this.onExceeded === 'downgrade_model' ? 'downgrade_model' as const : 'refuse' as const;
      return {
        allowed: false,
        reason: `Quota exceeded: ${quotaType} (${currentUsage.toFixed(4)} >= ${limit})`,
        remainingBudget: 0,
        suggestedAction,
      };
    }

    return {
      allowed: true,
      remainingBudget: limit - currentUsage,
      suggestedAction: ratio >= this.warningThreshold ? 'downgrade_model' : 'proceed',
    };
  }

  private emitWarning(warning: QuotaWarningEvent): void {
    for (const listener of this.warningListeners) {
      listener(warning);
    }
  }
}
