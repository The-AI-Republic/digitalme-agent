import crypto from 'node:crypto';
import type { ToolDefinition } from '../tools/types.js';

export function generateId(): string {
  return crypto.randomUUID();
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** Stable UUID for transcript dedup, parentId chaining, and artifact references. Required. */
  id: string;
  /** ISO 8601 timestamp, set at creation time. Used by microcompact and transcript ordering. Optional. */
  timestamp?: string;
  /** True for internally-generated messages (compaction summaries, synthetic continuations).
   *  Excluded from getCanonicalHistory() to prevent leaking into platform reconciliation. */
  synthetic?: boolean;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface SystemPromptBlock {
  text: string;
  cachePolicy: 'stable' | 'volatile';
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Structured system prompt blocks for providers that support per-block cache control. */
  systemPromptBlocks?: SystemPromptBlock[];
  /** Maximum tokens in the model response. */
  maxOutputTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type ModelStepResult =
  | { type: 'final_text'; text: string; truncated?: boolean; tokenUsage?: TokenUsage }
  | { type: 'tool_calls'; calls: ToolCall[]; tokenUsage?: TokenUsage };

export abstract class ModelClient {
  abstract generate(request: CompletionRequest): Promise<ModelStepResult>;
}
