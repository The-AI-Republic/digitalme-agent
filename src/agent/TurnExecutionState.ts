import type { TokenUsage } from '../models/ModelClient.js';

/**
 * Request-scoped execution state for a single turn.
 * Created by TurnExecutor at the start of each turn, disposed at turn end.
 * NOT stored in the global RuntimeStore — this is local to the turn.
 *
 * Consolidates scattered counters from TurnContext (turnCount, tokenUsage),
 * TurnState (modelTurnCount, toolCallCount, pendingToolCallIds), and
 * ActiveTurn (status, timing) into one inspectable object.
 */
export class TurnExecutionState {
  /** ReAct loop iteration index */
  iterationIndex = 0;
  /** Number of model API calls made */
  modelCallCount = 0;
  /** Number of tool calls made */
  toolCallCount = 0;
  /** Tool call IDs currently in-flight */
  readonly pendingToolCallIds = new Set<string>();
  /** Latest token usage from the model */
  tokenUsage: TokenUsage | undefined;
  /** Why the turn continues (set after each iteration) */
  continuationReason: 'tool_calls' | undefined;
  /** Why the turn ended (set on completion) */
  terminalReason: 'final_text' | 'max_turns' | 'aborted' | 'error' | undefined;
  /** When this turn started */
  readonly startedAt = Date.now();
  /** When this turn ended (set on dispose) */
  completedAt: number | undefined;

  beginModelCall() {
    this.iterationIndex += 1;
    this.modelCallCount += 1;
  }

  registerToolCall(callId: string) {
    this.toolCallCount += 1;
    this.pendingToolCallIds.add(callId);
  }

  resolveToolCall(callId: string) {
    this.pendingToolCallIds.delete(callId);
  }

  setTokenUsage(usage: TokenUsage | undefined) {
    this.tokenUsage = usage;
  }

  dispose(reason: TurnExecutionState['terminalReason']) {
    this.terminalReason = reason;
    this.completedAt = Date.now();
  }

  snapshot() {
    return {
      iterationIndex: this.iterationIndex,
      modelCallCount: this.modelCallCount,
      toolCallCount: this.toolCallCount,
      pendingToolCalls: this.pendingToolCallIds.size,
      tokenUsage: this.tokenUsage,
      continuationReason: this.continuationReason,
      terminalReason: this.terminalReason,
      durationMs: this.completedAt
        ? this.completedAt - this.startedAt
        : Date.now() - this.startedAt,
    };
  }
}
