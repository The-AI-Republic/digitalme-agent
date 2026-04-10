import type { TokenUsage } from '../models/ModelClient.js';

export class TurnExecutionState {
  private iterationIndex = 0;
  private modelTurnCount = 0;
  private toolCallCount = 0;
  private readonly pendingToolCallIds = new Set<string>();
  private tokenUsage?: TokenUsage;

  incrementIteration() {
    this.iterationIndex += 1;
  }

  getIterationIndex() {
    return this.iterationIndex;
  }

  beginModelTurn() {
    this.modelTurnCount += 1;
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

  getTokenUsage() {
    return this.tokenUsage;
  }

  snapshot() {
    return {
      iterationIndex: this.iterationIndex,
      modelTurnCount: this.modelTurnCount,
      toolCallCount: this.toolCallCount,
      pendingToolCalls: this.pendingToolCallIds.size,
      tokenUsage: this.tokenUsage,
    };
  }
}
