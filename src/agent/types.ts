import type { HistoryMessage } from '../protocol/types.js';
import type { Message, TokenUsage } from '../models/ModelClient.js';
import type { IToolRegistry } from '../tools/registry.js';
import type { TurnExecutor } from './TurnExecutor.js';

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
  | { type: 'done'; truncated?: boolean; tokenUsage?: TokenUsage }
  | { type: 'error'; message: string };

export interface TurnExecutionResult {
  finalText: string;
  tokenUsage?: TokenUsage;
  promptMessages: Message[];
  completedTurns: number;
  toolCallCount: number;
}

export interface ExecutionOptions {
  /** Override max turns (default: config.limits.max_turns) */
  maxTurns?: number;
  /** Override max output tokens (default: config.model.max_output_tokens) */
  maxOutputTokens?: number;
  /** Override model name (default: config.model.name) */
  model?: string;
  /** Override tool registry (default: constructor-injected registry) */
  toolRegistry?: IToolRegistry;
}

export type TurnExecutorLike = {
  run: TurnExecutor['run'];
};

export interface ForkedAgentConfig {
  forkLabel: string;
  skipTranscript?: boolean;
}

export interface ForkedAgentResult {
  totalUsage: TokenUsage;
  finalText: string;
}

export interface ForkedAgentHandle {
  id: string;
  forkLabel: string;
  abort: () => void;
  promise: Promise<ForkedAgentResult>;
}

/**
 * Consumes an async generator, forwarding each yielded value to `onEvent`,
 * and returns the generator's return value.
 */
export async function consumeGenerator<TYield, TReturn>(
  gen: AsyncGenerator<TYield, TReturn>,
  onEvent: (event: TYield) => void,
): Promise<TReturn> {
  let result = await gen.next();
  while (!result.done) {
    onEvent(result.value);
    result = await gen.next();
  }
  return result.value;
}
