import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfig } from '../config/schema.js';
import type { AgentEvent, TurnExecutorLike, TurnSubmission } from './types.js';
import { EventQueue } from './EventQueue.js';
import { SessionRuntime, type SessionRuntimeConfig } from './SessionRuntime.js';
import { SessionState } from './SessionState.js';
import { TurnExecutor } from './TurnExecutor.js';
import { TranscriptRecorder } from './transcript/TranscriptRecorder.js';
import type { ITranscriptRecorder } from './transcript/types.js';

export interface SessionManagerDeps {
  turnExecutor?: TurnExecutorLike;
  transcriptRecorder?: ITranscriptRecorder;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly turnExecutor: TurnExecutorLike;
  private readonly transcriptRecorder: ITranscriptRecorder;
  private readonly runtimeConfig: SessionRuntimeConfig;
  private readonly storageDir: string;
  private draining = false;

  constructor(
    private readonly config: AgentConfig,
    deps: SessionManagerDeps = {},
  ) {
    this.turnExecutor = deps.turnExecutor ?? new TurnExecutor(config);
    this.transcriptRecorder = deps.transcriptRecorder ?? new TranscriptRecorder();
    this.storageDir = config.context.tool_result_persistence.storage_dir;
    const sm = config.context.session_memory;
    this.runtimeConfig = {
      forkedAgentsEnabled: config.forked_agents?.enabled ?? true,
      maxConcurrentForks: config.forked_agents?.max_concurrent ?? 2,
      hooksEnabled: config.hooks?.post_turn?.enabled ?? true,
      hookTimeoutMs: config.hooks?.post_turn?.timeout_ms ?? 30_000,
      sessionMemoryConfig: sm.enabled ? {
        enabled: true,
        tokensBetweenUpdates: sm.tokens_between_updates,
        toolCallsBetweenUpdates: sm.tool_calls_between_updates,
        minimumTokensToInit: sm.minimum_tokens_to_init,
        maxTotalTokens: sm.max_total_tokens,
        maxSectionTokens: sm.max_section_tokens,
        storageDir: config.context.tool_result_persistence.storage_dir,
      } : undefined,
    };

    // Fire-and-forget: clean up orphaned temp directories from previous crashes
    this.sweepOrphanedTempFiles().catch(() => { /* non-fatal */ });
  }

  async execute(submission: TurnSubmission, events: EventQueue<AgentEvent>) {
    if (this.draining) {
      throw new Error('shutting_down');
    }

    this.evictExpiredSessions();
    const runtime = await this.getOrCreateRuntime(submission);
    await runtime.execute(submission, events);
  }

  getStats() {
    let activeTurns = 0;
    for (const runtime of this.sessions.values()) {
      if (runtime.hasActiveTurn()) {
        activeTurns += 1;
      }
    }
    return {
      activeSessions: this.sessions.size,
      activeTurns,
      sessionTtlSeconds: this.config.limits.session_ttl_seconds,
      maxActiveSessions: this.config.limits.max_active_sessions,
    };
  }

  beginDrain() {
    this.draining = true;
    for (const runtime of this.sessions.values()) {
      runtime.abortForkedAgents();
    }
  }

  private async getOrCreateRuntime(submission: TurnSubmission) {
    const existing = this.sessions.get(submission.conversationId);
    if (existing) {
      return existing;
    }

    this.evictToCapacity();

    // Cold-start: attempt transcript load first
    let state: SessionState;
    const loaded = await this.transcriptRecorder
      .loadTranscript(submission.conversationId)
      .catch(() => null);

    if (loaded && loaded.messages.length > 0) {
      // Transcript exists — use it as the richer source
      state = new SessionState(submission.conversationId, []);
      state.initializeFromTranscript(loaded.messages);
      // Seed the recorder's parentId cursor so next recordMessage() chains correctly
      if (loaded.leafId) {
        this.transcriptRecorder.seedParentId(submission.conversationId, loaded.leafId);
      }
      // Still reconcile with platform history to detect divergence
      state.reconcileWithPlatformHistory(submission.history);
    } else {
      // No transcript — initialize from platform history (existing behavior)
      state = new SessionState(submission.conversationId, submission.history);
    }

    const runtime = new SessionRuntime(
      state,
      {
        turnExecutor: this.turnExecutor,
        transcriptRecorder: this.transcriptRecorder,
      },
      this.runtimeConfig,
    );
    this.sessions.set(submission.conversationId, runtime);
    return runtime;
  }

  private evictExpiredSessions() {
    const ttlMs = this.config.limits.session_ttl_seconds * 1000;
    const cutoff = Date.now() - ttlMs;
    for (const [conversationId, runtime] of this.sessions.entries()) {
      if (runtime.hasActiveWork()) {
        continue;
      }
      if (runtime.state.getLastAccessedAt() < cutoff) {
        runtime.abortForkedAgents();
        this.cleanupConversationTempDir(conversationId).catch(() => { /* best-effort */ });
        this.sessions.delete(conversationId);
      }
    }
  }

  private evictToCapacity() {
    const maxActiveSessions = this.config.limits.max_active_sessions;
    if (this.sessions.size < maxActiveSessions) {
      return;
    }

    const idleSessions = [...this.sessions.entries()]
      .filter(([, runtime]) => !runtime.hasActiveWork())
      .sort((left, right) => left[1].state.getLastAccessedAt() - right[1].state.getLastAccessedAt());

    while (this.sessions.size >= maxActiveSessions && idleSessions.length > 0) {
      const next = idleSessions.shift();
      if (!next) {
        break;
      }
      next[1].abortForkedAgents();
      this.cleanupConversationTempDir(next[0]).catch(() => { /* best-effort */ });
      this.sessions.delete(next[0]);
    }
  }

  /**
   * On startup, delete orphaned temp directories from previous crashes.
   * Any directory older than the session TTL is considered orphaned.
   */
  private async sweepOrphanedTempFiles(): Promise<void> {
    try {
      const entries = await fs.readdir(this.storageDir);
      const cutoff = Date.now() - this.config.limits.session_ttl_seconds * 1000;
      for (const entry of entries) {
        const dirPath = path.join(this.storageDir, entry);
        try {
          const stat = await fs.stat(dirPath);
          if (stat.isDirectory() && stat.mtimeMs < cutoff) {
            await fs.rm(dirPath, { recursive: true, force: true });
          }
        } catch {
          // Individual entry failure is non-fatal
        }
      }
    } catch {
      // storageDir may not exist yet on first run — ignore
    }
  }

  private async cleanupConversationTempDir(conversationId: string): Promise<void> {
    const dirPath = path.join(this.storageDir, conversationId);
    await fs.rm(dirPath, { recursive: true, force: true });
  }
}
