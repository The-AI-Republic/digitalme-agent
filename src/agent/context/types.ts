import type { Message, TokenUsage } from '../../models/ModelClient.js';

export type PressureBand = 'nominal' | 'microcompact' | 'projection' | 'overflow';

export interface ConversationSummary {
  text: string;
  coversMessageCount: number;
  generatedAt: number;
  estimatedTokens: number;
}

export interface SessionMemoryContent {
  text: string;
  lastExtractedAt: number;
  lastExtractedTokenCount: number;
  estimatedTokens: number;
}

export interface MicrocompactResult {
  messages: Message[];
  tokensFreed: number;
  resultsCleared: number;
}

export interface CompactionResult {
  messages: Message[];
  preCompactTokens: number;
  postCompactTokens: number;
}

/**
 * Atomic unit of compaction: one assistant message (with toolCalls[]) plus all
 * its corresponding tool result messages. Compaction boundaries must fall
 * between groups, never within. A plain text message is its own group of size 1.
 */
export interface AssistantToolGroup {
  startIndex: number;
  endIndex: number;
  messageCount: number;
  estimatedTokens: number;
}

export interface ReactiveCompactResult {
  messages: Message[];
  summary: ConversationSummary;
  succeeded: boolean;
}

export interface ProjectionInput {
  summary?: ConversationSummary;
  sessionMemory?: SessionMemoryContent;
  fullHistory: Message[];
  latestUserMessage: string;
  modelName: string;
  lastKnownUsage?: TokenUsage;
  systemPromptTokenEstimate: number;
}

export interface ModelMetadata {
  contextWindowSize: number;
  maxOutputTokens: number;
}

export interface TokenBudgetConfig {
  modelMetadata: Record<string, ModelMetadata>;
  defaultContextWindowSize: number;
  defaultMaxOutputTokens: number;
  microcompactRatio: number;
  projectionRatio: number;
  overflowRatio: number;
  safetyMargin: number;
}

export interface ToolResultPersistenceConfig {
  defaultMaxResultChars: number;
  perToolThresholds?: Record<string, number>;
  perMessageBudgetChars: number;
  previewSizeBytes: number;
  storageDir: string;
}

export interface MicrocompactConfig {
  gapThresholdMinutes: number;
  keepRecentResults: number;
  compactableTools: Set<string>;
  clearedMarker: string;
}

/**
 * Result of prepareContextForModelCall pipeline.
 */
export interface PrepareContextResult {
  messages: Message[];
  rewrote: boolean;
  pressure: PressureBand;
  /** Number of messages removed during compaction (0 if no compaction ran). */
  messagesRemoved: number;
  /** Estimated tokens saved during compaction (0 if no compaction ran). */
  tokensSaved: number;
  /** Which compaction ran, if any. */
  compactionType?: 'microcompact' | 'projection' | 'reactive';
}
