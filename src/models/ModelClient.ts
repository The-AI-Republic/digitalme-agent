import type { ToolDefinition } from '../tools/types.js';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
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
