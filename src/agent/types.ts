import type { HistoryMessage } from '../protocol/types.js';
import type { Message, TokenUsage } from '../models/ModelClient.js';
import type { ModelConfig } from '../config/schema.js';
import type { IToolRegistry } from '../tools/registry.js';
import type { TurnExecutor } from './TurnExecutor.js';
import type { TerminalReason } from './types/recovery.js';
import type { ModelUsageRecord, QuotaWarningEvent as UsageQuotaWarning } from '../usage/types.js';
import type { SpanContext } from '@opentelemetry/api';

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
  | { type: 'done'; truncated?: boolean; tokenUsage?: TokenUsage; terminalReason?: TerminalReason }
  | { type: 'error'; message: string }
  | { type: 'recovery'; reason: string; detail?: Record<string, unknown> }
  | { type: 'usage'; record: ModelUsageRecord }
  | { type: 'quota_warning'; quotaType: string; currentUsage: number; limit: number; percentUsed: number }
  | { type: 'quota_exceeded'; reason: string; refusalMessage: string }
  | { type: 'guardrail_block'; phase: 'input' | 'output'; category: string; rule: string }
  | { type: 'guardrail_modify'; category: string; rule: string };

export interface ToolSummaryEntry {
  callId: string;
  toolName: string;
  summary: string;
  durationMs: number;
  success: boolean;
}

export interface TurnExecutionResult {
  finalText: string;
  tokenUsage?: TokenUsage;
  newMessages: Message[];
  completedTurns: number;
  toolCallCount: number;
  /** Tool-use summaries for logging/monitoring and future prompt projection. NOT model-facing. */
  toolSummaries?: ToolSummaryEntry[];
  /** Span context of the interaction that produced this result — used to link fork/hook spans. */
  interactionSpanContext?: SpanContext;
}

export interface ExecutionOptions {
  /** Override max turns (default: config.limits.max_turns) */
  maxTurns?: number;
  /** Override max output tokens (default: config.model.max_output_tokens) */
  maxOutputTokens?: number;
  /** Override model name (default: config.model.name) */
  model?: string;
  /** Override the full model config for internal/helper work. */
  modelConfig?: ModelConfig;
  /** Override tool registry (default: constructor-injected registry) */
  toolRegistry?: IToolRegistry;
  /** Optional guardrail scope for future fan-facing vs internal policy separation. */
  guardrailScope?: 'public' | 'internal';
}

export type TurnExecutorLike = {
  run: TurnExecutor['run'];
};

/** Re-exported for downstream consumers that need the import type without circular deps. */
export type { ModelUsageRecord } from '../usage/types.js';

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
