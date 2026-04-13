import { z } from 'zod';

export interface ToolPolicyConfig {
  [key: string]: unknown;
}

export interface ToolContext {
  conversationId: string;
  signal: AbortSignal;
  policyConfig: ToolPolicyConfig;
  currentModelName?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolExecutionResult<TData = unknown> {
  success: boolean;
  data: TData;
  renderForModel(): string;
}

export interface ToolMetadata {
  timeoutMs: number;
  maxResultChars: number;
  policyCategory: 'search' | 'memory' | 'action';
}

export const DEFAULT_TOOL_METADATA: ToolMetadata = {
  timeoutMs: 10_000,
  maxResultChars: 20_000,
  policyCategory: 'search',
};

/**
 * Tool interface with default generic params for type erasure.
 * The registry and executor store tools as Tool (no params), which resolves
 * to Tool<Record<string, unknown>, unknown>. Concrete tools implement
 * Tool<SpecificInput, SpecificData> for internal type safety.
 */
export interface Tool<TInput = Record<string, unknown>, TData = unknown> {
  readonly name: string;
  readonly definition: ToolDefinition;
  readonly metadata: ToolMetadata;
  readonly inputSchema: z.ZodType<TInput>;

  execute(args: TInput, context: ToolContext): Promise<ToolExecutionResult<TData>>;

  /** Input-dependent concurrency classification. Defaults to false when not defined. */
  isConcurrencySafe?(args: TInput): boolean;

  /** Semantic validation beyond schema. Return error string or null. */
  validateInput?(args: TInput, context: ToolContext): string | null;

  /** Short summary for logging/monitoring (NOT model-facing). */
  summarizeResult?(args: TInput, result: ToolExecutionResult<TData>): string;
}
