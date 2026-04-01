import type { TokenUsage } from '../models/ModelClient.js';

export class TurnState {
  private modelTurnCount = 0;
  private toolCallCount = 0;
  private readonly pendingToolCallIds = new Set<string>();
  private tokenUsage?: TokenUsage;

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

  setTokenUsage(tokenUsage: TokenUsage | undefined) {
    this.tokenUsage = tokenUsage;
  }

  snapshot() {
    return {
      modelTurnCount: this.modelTurnCount,
      toolCallCount: this.toolCallCount,
      pendingToolCalls: this.pendingToolCallIds.size,
      tokenUsage: this.tokenUsage,
    };
  }
}
