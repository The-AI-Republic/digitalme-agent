import path from 'node:path';
import type { AgentEvent, ForkedAgentHandle, TurnExecutionResult, TurnSubmission } from './types.js';
import { consumeGenerator } from './types.js';
import type { TurnExecutorLike } from './types.js';
import { assertSafePathComponent } from '../utils/safePath.js';
import { ActiveTurn } from './ActiveTurn.js';
import { EventQueue } from './EventQueue.js';
import { SessionState } from './SessionState.js';
import { ForkSemaphore } from './fork/ForkSemaphore.js';
import { PostTurnHookRegistry } from './hooks/PostTurnHooks.js';
import { SessionMemory, type SessionMemoryConfig } from './context/SessionMemory.js';
import { createSessionMemoryHook } from './context/SessionMemoryHook.js';
import type {
  ITranscriptRecorder,
  SessionReseededEntry,
  TaskStartedEntry,
  TaskCompletedEntry,
  TaskFailedEntry,
} from './transcript/types.js';
import { ConversationUsageTracker } from '../usage/ConversationUsageTracker.js';
import type { UsageAggregator } from '../usage/UsageAggregator.js';
import type { UsagePersistence } from '../usage/UsagePersistence.js';

export interface SessionRuntimeDeps {
  turnExecutor: TurnExecutorLike;
  transcriptRecorder: ITranscriptRecorder;
}

export interface SessionRuntimeConfig {
  forkedAgentsEnabled?: boolean;
  maxConcurrentForks?: number;
  hooksEnabled?: boolean;
  hookTimeoutMs?: number;
  sessionMemoryConfig?: {
    enabled: boolean;
    tokensBetweenUpdates: number;
    toolCallsBetweenUpdates: number;
    minimumTokensToInit: number;
    maxTotalTokens: number;
    maxSectionTokens: number;
    storageDir: string;
  };
}

export class SessionRuntime {
  private activeTurn?: ActiveTurn;
  private readonly activeForkedAgents = new Map<string, ForkedAgentHandle>();
  readonly forkSemaphore: ForkSemaphore;
  readonly hookRegistry: PostTurnHookRegistry;
  private readonly forkedAgentsEnabled: boolean;
  private readonly hooksEnabled: boolean;
  readonly sessionMemory?: SessionMemory;
  readonly usageTracker: ConversationUsageTracker;
  private readonly usageAggregator?: UsageAggregator;
  private readonly usagePersistence?: UsagePersistence;

  constructor(
    readonly state: SessionState,
    private readonly deps: SessionRuntimeDeps,
    runtimeConfig?: SessionRuntimeConfig,
    usageAggregator?: UsageAggregator,
    usagePersistence?: UsagePersistence,
  ) {
    this.forkedAgentsEnabled = runtimeConfig?.forkedAgentsEnabled ?? true;
    this.hooksEnabled = runtimeConfig?.hooksEnabled ?? true;
    this.forkSemaphore = new ForkSemaphore(runtimeConfig?.maxConcurrentForks ?? 2);
    this.hookRegistry = new PostTurnHookRegistry(runtimeConfig?.hookTimeoutMs ?? 30_000, deps.transcriptRecorder);
    this.usageTracker = new ConversationUsageTracker(state.conversationId);
    this.usageAggregator = usageAggregator;
    this.usagePersistence = usagePersistence;

    // Register session memory extraction hook if enabled
    const smConfig = runtimeConfig?.sessionMemoryConfig;
    if (smConfig?.enabled) {
      this.sessionMemory = new SessionMemory({
        enabled: true,
        tokensBetweenUpdates: smConfig.tokensBetweenUpdates,
        toolCallsBetweenUpdates: smConfig.toolCallsBetweenUpdates,
        minimumTokensToInit: smConfig.minimumTokensToInit,
        maxTotalTokens: smConfig.maxTotalTokens,
        maxSectionTokens: smConfig.maxSectionTokens,
        storagePath: path.join(smConfig.storageDir, assertSafePathComponent(state.conversationId), 'session-memory.md'),
      });
      this.hookRegistry.register(createSessionMemoryHook(this.sessionMemory), 'session_memory');
    }
  }

  hasActiveTurn() {
    return Boolean(this.activeTurn);
  }

  hasActiveWork(): boolean {
    return this.hasActiveTurn() || this.activeForkedAgents.size > 0;
  }

  /** Whether fork launches are permitted by config. Check before calling launchForkedAgent. */
  canFork(): boolean {
    return this.forkedAgentsEnabled;
  }

  registerForkedAgent(handle: ForkedAgentHandle): void {
    this.activeForkedAgents.set(handle.id, handle);
    handle.promise.then(
      () => this.activeForkedAgents.delete(handle.id),
      () => this.activeForkedAgents.delete(handle.id),
    );
  }

  abortForkedAgents(): void {
    for (const handle of this.activeForkedAgents.values()) {
      handle.abort();
    }
    this.activeForkedAgents.clear();
  }

  getActiveForkedAgentCount(): number {
    return this.activeForkedAgents.size;
  }

  async execute(submission: TurnSubmission, events: EventQueue<AgentEvent>) {
    this.state.touch();
    const reconcileResult = this.state.reconcileWithPlatformHistory(submission.history);
    if (reconcileResult === 'reseeded') {
      // Clear stale session memory on reseed to prevent pollution from previous conversation
      if (this.sessionMemory) {
        await this.sessionMemory.clear().catch(() => {});
      }

      const reseededEntry: SessionReseededEntry = {
        type: 'session_reseeded',
        conversationId: submission.conversationId,
        taskId: submission.requestId,
        timestamp: new Date().toISOString(),
        historyCount: submission.history.length,
      };
      await this.deps.transcriptRecorder.recordLifecycleEvent(reseededEntry);
    }

    const activeTurn = new ActiveTurn(submission.requestId, this.state.getNextTurnId());
    this.activeTurn = activeTurn;

    const startedEntry: TaskStartedEntry = {
      type: 'task_started',
      conversationId: submission.conversationId,
      taskId: submission.requestId,
      turnId: activeTurn.turnId,
      timestamp: new Date().toISOString(),
      session: this.state.snapshot(),
      platformHistoryCount: submission.history.length,
    };
    await this.deps.transcriptRecorder.recordLifecycleEvent(startedEntry);

    try {
      // Track terminal reason from the event stream to distinguish model_error from success
      let terminalReason: string | undefined;
      const result = await consumeGenerator(
        this.deps.turnExecutor.run(
          { ...submission, promptHistory: this.state.getMessages() },
          undefined,
          activeTurn,
          this.usageTracker,
        ),
        (event) => {
          events.push(event);
          if (event.type === 'done' && (event as { terminalReason?: { reason: string } }).terminalReason) {
            terminalReason = (event as { terminalReason: { reason: string } }).terminalReason.reason;
          }
        },
      );

      // Terminal failures should bypass normal success commit / hooks / usage sync paths.
      if (terminalReason === 'model_error' || terminalReason === 'aborted') {
        activeTurn.fail(new Error(`Terminal reason: ${terminalReason}`));
        const failedEntry: TaskFailedEntry = {
          type: 'task_failed',
          conversationId: submission.conversationId,
          taskId: submission.requestId,
          turnId: activeTurn.turnId,
          timestamp: new Date().toISOString(),
          error: `Terminal reason: ${terminalReason}`,
          turn: activeTurn.snapshot(),
        };
        await this.deps.transcriptRecorder.recordLifecycleEvent(failedEntry);
        return;
      }

      this.commitResult(result, activeTurn);

      // Fire-and-forget: launch post-turn hooks AFTER committing result
      if (this.hooksEnabled && this.hookRegistry.size > 0) {
        this.hookRegistry.runAll({
          sessionState: this.state,
          sessionRuntime: this,
          forkSemaphore: this.forkSemaphore,
          turnExecutor: this.deps.turnExecutor,
          transcriptRecorder: this.deps.transcriptRecorder,
          conversationId: submission.conversationId,
          lastResult: result,
          interactionSpanContext: result.interactionSpanContext,
        }).catch(() => {
          // Swallowed — hook errors never crash the main agent
        });
      }

      // Update usage tracker tool call count from result
      this.usageTracker.setToolCallCount(result.toolCallCount);

      // Sync conversation usage to aggregator and persist
      if (this.usageAggregator) {
        this.usageAggregator.updateConversation(this.usageTracker.getUsage());
      }
      if (this.usagePersistence) {
        this.usagePersistence.save(this.usageTracker.snapshot()).catch((err) => {
          console.warn(`[SessionRuntime] Failed to persist usage for ${submission.conversationId}:`, err);
        });
      }

      const completedEntry: TaskCompletedEntry = {
        type: 'task_completed',
        conversationId: submission.conversationId,
        taskId: submission.requestId,
        turnId: activeTurn.turnId,
        timestamp: new Date().toISOString(),
        finalText: result.finalText,
        completedTurns: result.completedTurns,
        toolCallCount: result.toolCallCount,
        tokenUsage: result.tokenUsage,
        session: this.state.snapshot(),
      };
      await this.deps.transcriptRecorder.recordLifecycleEvent(completedEntry);
    } catch (error) {
      activeTurn.fail(error);
      const failedEntry: TaskFailedEntry = {
        type: 'task_failed',
        conversationId: submission.conversationId,
        taskId: submission.requestId,
        turnId: activeTurn.turnId,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        turn: activeTurn.snapshot(),
      };
      await this.deps.transcriptRecorder.recordLifecycleEvent(failedEntry);
      throw error;
    } finally {
      this.activeTurn = undefined;
      this.state.touch();
    }
  }

  /** Restore usage state from persistence (call during cold start). */
  async restoreUsage(): Promise<void> {
    if (!this.usagePersistence) return;
    try {
      const snapshot = await this.usagePersistence.load(this.state.conversationId);
      if (snapshot) {
        this.usageTracker.restore(snapshot);
      }
    } catch (error) {
      // Log but do not block session creation — corrupted files need visibility
      console.warn(`[SessionRuntime] Failed to restore usage for ${this.state.conversationId}:`, error);
    }
  }

  snapshot() {
    return {
      session: this.state.snapshot(),
      activeTurn: this.activeTurn?.snapshot(),
      activeForkedAgents: this.activeForkedAgents.size,
      usage: this.usageTracker.getUsage(),
    };
  }

  private commitResult(result: TurnExecutionResult, activeTurn: ActiveTurn) {
    this.state.appendMessages(result.newMessages, result.toolSummaries);
    activeTurn.complete(result.tokenUsage);
  }
}
