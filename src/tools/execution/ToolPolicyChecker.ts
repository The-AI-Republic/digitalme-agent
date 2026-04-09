import type { ToolMetadata, ToolContext } from '../types.js';
import type { ToolPolicyDecision } from './types.js';

export interface IToolPolicyChecker {
  /**
   * Evaluate whether a tool call is allowed.
   * Policy checks run serially in Phase 1 (before batch execution)
   * and do NOT require concurrent access safety.
   */
  checkPolicy(
    toolName: string,
    policyCategory: ToolMetadata['policyCategory'],
    args: Record<string, unknown>,
    context: ToolContext,
  ): ToolPolicyDecision;
}

/**
 * Default pass-through policy checker that always allows.
 * Replace with a real implementation when rate limiting,
 * moderation, or creator restrictions are needed.
 */
export class DefaultToolPolicyChecker implements IToolPolicyChecker {
  checkPolicy(): ToolPolicyDecision {
    return { allowed: true };
  }
}
