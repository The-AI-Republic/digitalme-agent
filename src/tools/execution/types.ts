export type ToolErrorCategory =
  | 'validation_error'
  | 'policy_rejected'
  | 'timeout'
  | 'execution_error'
  | 'aborted'
  | 'unknown_tool';

export interface NormalizedToolResult {
  success: boolean;
  truncated: boolean;
  originalChars: number;
  errorCategory?: ToolErrorCategory;
}

export interface ToolExecutionRecord {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: NormalizedToolResult;
  /** Rendered + truncated string for model prompt history. */
  modelContent: string;
  durationMs: number;
  /** Short description for logging/monitoring (NOT model-facing). */
  summary: string;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface ParsedToolCall {
  callId: string;
  toolName: string;
  rawArguments: string;
  tool: import('../types.js').Tool | undefined;
  parsedInput: unknown;
  parseError?: string;
  validationError?: string;
  policyDecision?: ToolPolicyDecision;
  safe: boolean;
}

export interface Batch {
  concurrent: boolean;
  items: ParsedToolCall[];
}
