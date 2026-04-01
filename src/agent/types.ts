import type { HistoryMessage } from '../protocol/types.js';
import type { Message, TokenUsage } from '../models/ModelClient.js';

export interface TurnSubmission {
  requestId: string;
  conversationId: string;
  userMessage: string;
  history: HistoryMessage[];
  promptHistory?: Message[];
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; name: string; callId: string }
  | { type: 'tool_end'; name: string; callId: string; success: boolean }
  | { type: 'done'; tokenUsage?: TokenUsage }
  | { type: 'error'; message: string };

export interface TurnExecutionResult {
  finalText: string;
  tokenUsage?: TokenUsage;
  promptMessages: Message[];
  completedTurns: number;
  toolCallCount: number;
}
