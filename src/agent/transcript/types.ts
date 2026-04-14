import type { Message, TokenUsage } from '../../models/ModelClient.js';
import type { ArtifactRef } from '../context/ToolResultPersistence.js';
// ----- Entry types -----

export interface TranscriptEntry {
  type:
    | 'message'
    | 'task_started'
    | 'task_completed'
    | 'task_failed'
    | 'session_reseeded'
    | 'fork_started'
    | 'fork_completed'
    | 'fork_failed'
    | 'fork_rejected'
    | 'subagent_started'
    | 'subagent_completed'
    | 'subagent_failed'
    | 'hook_executed'
    | 'compact_started'
    | 'compact_completed';
  conversationId: string;
  taskId?: string;
  turnId?: number;
  timestamp: string;
}

export interface MessageEntry extends TranscriptEntry {
  type: 'message';
  parentId: string | null;
  message: Message;
  isSidechain?: boolean;
  agentId?: string;
  artifactRef?: ArtifactRef;
}

export interface SessionSnapshot {
  conversationId: string;
  createdAt: string;
  lastAccessedAt: string;
  canonicalHistoryCount: number;
  messageCount: number;
  toolUseSummaryCount: number;
  nextTurnId: number;
  revision: number;
}

export interface TaskStartedEntry extends TranscriptEntry {
  type: 'task_started';
  session: SessionSnapshot;
  platformHistoryCount: number;
}

export interface TaskCompletedEntry extends TranscriptEntry {
  type: 'task_completed';
  finalText: string;
  completedTurns: number;
  toolCallCount: number;
  tokenUsage?: TokenUsage;
  session: SessionSnapshot;
}

export interface ActiveTurnSnapshot {
  taskId: string;
  turnId: number;
  startedAt: string;
  completedAt?: string;
  status: string;
  errorMessage?: string;
  executionState: unknown;
}

export interface TaskFailedEntry extends TranscriptEntry {
  type: 'task_failed';
  error: string;
  turn: ActiveTurnSnapshot;
}

export interface SessionReseededEntry extends TranscriptEntry {
  type: 'session_reseeded';
  historyCount: number;
}

// ----- Fork lifecycle entries -----

export interface ForkStartedEntry extends TranscriptEntry {
  type: 'fork_started';
  forkId: string;
  forkLabel: string;
}

export interface ForkCompletedEntry extends TranscriptEntry {
  type: 'fork_completed';
  forkId: string;
  forkLabel: string;
  tokenUsage: TokenUsage;
  durationMs: number;
  toolCallCount: number;
  transcriptPath?: string;
}

export interface ForkFailedEntry extends TranscriptEntry {
  type: 'fork_failed';
  forkId: string;
  forkLabel: string;
  error: string;
}

export interface ForkRejectedEntry extends TranscriptEntry {
  type: 'fork_rejected';
  forkLabel: string;
  reason: 'semaphore_full' | 'forks_disabled';
}

// ----- Subagent lifecycle entries -----

export interface SubagentStartedEntry extends TranscriptEntry {
  type: 'subagent_started';
  subagentType: string;
  model: string;
  toolCount: number;
}

export interface SubagentCompletedEntry extends TranscriptEntry {
  type: 'subagent_completed';
  subagentType: string;
  tokenUsage?: TokenUsage;
  toolCallCount: number;
  completedTurns: number;
  durationMs: number;
  model: string;
}

export interface SubagentFailedEntry extends TranscriptEntry {
  type: 'subagent_failed';
  subagentType: string;
  error: string;
}

// ----- Hook lifecycle entries -----

export type HookOutcome = 'success' | 'error' | 'timeout';

export interface HookExecutedEntry extends TranscriptEntry {
  type: 'hook_executed';
  hookName: string;
  outcome: HookOutcome;
  durationMs: number;
  error?: string;
}

// ----- Context pressure entries -----

export interface CompactStartedEntry extends TranscriptEntry {
  type: 'compact_started';
  trigger: 'reactive' | 'proactive';
  pressureBand: string;
}

export interface CompactCompletedEntry extends TranscriptEntry {
  type: 'compact_completed';
  trigger: 'reactive' | 'proactive';
  messagesRemoved: number;
  tokensSaved: number;
}

// ----- Recorder interface -----

export interface RecordMessageOpts {
  taskId?: string;
  turnId?: number;
  parentOverride?: string;
  artifactRef?: ArtifactRef;
  isSidechain?: boolean;
  agentId?: string;
}

export interface AgentMetadata {
  agentId: string;
  agentType: string;
  description: string;
  createdAt: string;
  config?: Record<string, unknown>;
}

export interface ITranscriptRecorder {
  recordMessage(
    conversationId: string,
    message: Message,
    opts?: RecordMessageOpts,
  ): Promise<void>;

  recordLifecycleEvent(entry: TranscriptEntry): Promise<void>;

  insertMessageChain(
    conversationId: string,
    messages: Message[],
    isSidechain?: boolean,
    agentId?: string,
    startingParentId?: string | null,
  ): Promise<void>;

  writeAgentMetadata(
    conversationId: string,
    metadata: AgentMetadata,
  ): Promise<void>;

  loadTranscript(conversationId: string): Promise<{ messages: Message[]; leafId: string | null }>;

  seedParentId(conversationId: string, leafId: string): void;
}
