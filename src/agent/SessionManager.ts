import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfig } from '../config/schema.js';
import { assertSafePathComponent } from '../utils/safePath.js';
import { initialProcessRuntimeState, type ProcessRuntimeState } from './ProcessRuntimeState.js';
import type { AgentEvent, TurnExecutorLike, TurnSubmission } from './types.js';
import { EventQueue } from './EventQueue.js';
import { SessionRuntime, type SessionRuntimeConfig } from './SessionRuntime.js';
import { SessionState } from './SessionState.js';
import { TurnExecutor } from './TurnExecutor.js';
import { TranscriptRecorder } from './transcript/TranscriptRecorder.js';
import type { ITranscriptRecorder } from './transcript/types.js';
import { UsageAggregator } from '../usage/UsageAggregator.js';
import { UsagePersistence } from '../usage/UsagePersistence.js';
import { ToolRegistry, createToolRegistry } from '../tools/registry.js';
import { SkillRegistry } from '../skills/SkillRegistry.js';
import { buildSkillListingSection } from '../skills/SkillListingBuilder.js';
import { createCreatorSkillTool } from '../tools/CreatorSkillTool.js';
import { createSubagentTool } from './subagent/SubagentTool.js';
import { SkillTracker } from '../skills/SkillTracker.js';

export interface SessionManagerDeps {
  getState?: () => ProcessRuntimeState;
  turnExecutor?: TurnExecutorLike;
  transcriptRecorder?: ITranscriptRecorder;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly turnExecutor: TurnExecutorLike;
  private readonly transcriptRecorder: ITranscriptRecorder;
  private readonly runtimeConfig: SessionRuntimeConfig;
  private readonly storageDir: string;
  private readonly getProcessState: () => ProcessRuntimeState;
  readonly usageAggregator: UsageAggregator;
  private readonly usagePersistence: UsagePersistence;
  private readonly skillTracker: SkillTracker;
  private readonly skillRegistry?: SkillRegistry;

  constructor(
    private readonly config: AgentConfig,
    deps: SessionManagerDeps = {},
  ) {
    this.getProcessState = deps.getState ?? (() => initialProcessRuntimeState());
    this.transcriptRecorder = deps.transcriptRecorder ?? new TranscriptRecorder();
    this.usageAggregator = new UsageAggregator();
    this.usagePersistence = new UsagePersistence(config.context.tool_result_persistence.storage_dir);
    this.skillTracker = new SkillTracker();
    if (deps.turnExecutor) {
      this.turnExecutor = deps.turnExecutor;
    } else {
      const skillRegistry = new SkillRegistry();
      skillRegistry.load(config.skills.bundled_dir, config.skills.local_dir);
      this.skillRegistry = skillRegistry;
      if (skillRegistry.size > 0) {
        console.log(`Loaded ${skillRegistry.size} skills: ${skillRegistry.list().map((skill) => skill.name).join(', ')}`);
      }

      const skillListing = buildSkillListingSection(skillRegistry.list());
      const toolRegistry: ToolRegistry = createToolRegistry(config);

      const turnExecutor = new TurnExecutor(config, {
        transcriptRecorder: this.transcriptRecorder,
        toolRegistry,
        skillListing,
        usageAggregator: this.usageAggregator,
      });

      if (skillRegistry.size > 0) {
        toolRegistry.register(createCreatorSkillTool({
          skillRegistry,
          turnExecutor,
          parentToolRegistry: toolRegistry,
          defaultModelName: config.model.name,
          getSessionRuntime: (conversationId) => this.sessions.get(conversationId),
          guardrailConfig: config.guardrails,
          skillTracker: this.skillTracker,
        }));
      }

      // Register SubagentTool when enabled
      if (config.subagents?.enabled) {
        toolRegistry.register(createSubagentTool({
          turnExecutor,
          parentToolRegistry: toolRegistry,
          modelName: config.model.name,
          transcriptRecorder: this.transcriptRecorder,
        }));
      }

      this.turnExecutor = turnExecutor;
    }
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
    if (this.getProcessState().draining) {
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
      usage: {
        totalCostUsd: this.usageAggregator.getTotalCost(),
        dailyCostUsd: this.usageAggregator.getDailyCost(),
        monthlyCostUsd: this.usageAggregator.getMonthlyCost(),
      },
    };
  }

  beginDrain() {
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
      this.usageAggregator,
      this.usagePersistence,
    );

    // Restore usage from persistence on cold start
    await runtime.restoreUsage();

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
        this.usageAggregator.removeConversation(conversationId);
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
        // Preserve shared persistence directories; only per-conversation temp dirs are sweep candidates.
        if (entry === 'usage') {
          continue;
        }
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
    const dirPath = path.join(this.storageDir, assertSafePathComponent(conversationId));
    await fs.rm(dirPath, { recursive: true, force: true });
  }
}
