import type { Message, TokenUsage } from '../../models/ModelClient.js';
import type { ArtifactRef } from '../context/ToolResultPersistence.js';

// ----- Entry types -----

export interface TranscriptEntry {
  type: 'message' | 'task_started' | 'task_completed' | 'task_failed' | 'session_reseeded';
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
  turnState: unknown;
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

// ----- Recorder interface -----

export interface RecordMessageOpts {
  taskId?: string;
  turnId?: number;
  parentOverride?: string;
  artifactRef?: ArtifactRef;
  isSidechain?: boolean;
  agentId?: string;
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

  loadTranscript(conversationId: string): Promise<{ messages: Message[]; leafId: string | null }>;

  seedParentId(conversationId: string, leafId: string): void;
}
