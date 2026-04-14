import path from 'node:path';
import type { AgentEvent, ForkedAgentHandle, TurnExecutionResult, TurnSubmission } from './types.js';
import { consumeGenerator } from './types.js';
import type { TurnExecutorLike } from './types.js';
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

  constructor(
    readonly state: SessionState,
    private readonly deps: SessionRuntimeDeps,
    runtimeConfig?: SessionRuntimeConfig,
    usageAggregator?: UsageAggregator,
  ) {
    this.forkedAgentsEnabled = runtimeConfig?.forkedAgentsEnabled ?? true;
    this.hooksEnabled = runtimeConfig?.hooksEnabled ?? true;
    this.forkSemaphore = new ForkSemaphore(runtimeConfig?.maxConcurrentForks ?? 2);
    this.hookRegistry = new PostTurnHookRegistry(runtimeConfig?.hookTimeoutMs ?? 30_000, deps.transcriptRecorder);
    this.usageTracker = new ConversationUsageTracker(state.conversationId);
    this.usageAggregator = usageAggregator;

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
        storagePath: path.join(smConfig.storageDir, state.conversationId, 'session-memory.md'),
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
      const result = await consumeGenerator(
        this.deps.turnExecutor.run(
          { ...submission, promptHistory: this.state.getMessages() },
          undefined,
          activeTurn,
          this.usageTracker,
        ),
        (event) => events.push(event),
      );
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

      // Sync conversation usage to aggregator
      if (this.usageAggregator) {
        this.usageAggregator.updateConversation(this.usageTracker.getUsage());
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
