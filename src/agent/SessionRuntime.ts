import path from 'node:path';
import type { AgentEvent, ForkedAgentHandle, TurnExecutionResult, TurnSubmission } from './types.js';
import { consumeGenerator } from './types.js';
import type { TurnExecutorLike } from './types.js';
import { ActiveTurn } from './ActiveTurn.js';
import { EventQueue } from './EventQueue.js';
import type { IRolloutRecorder } from './RolloutRecorder.js';
import { SessionState } from './SessionState.js';
import { ForkSemaphore } from './fork/ForkSemaphore.js';
import { PostTurnHookRegistry } from './hooks/PostTurnHooks.js';
import { SessionMemory, type SessionMemoryConfig } from './context/SessionMemory.js';
import { createSessionMemoryHook } from './context/SessionMemoryHook.js';

interface SessionRuntimeDeps {
  turnExecutor: TurnExecutorLike;
  rolloutRecorder: IRolloutRecorder;
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

  constructor(
    readonly state: SessionState,
    private readonly deps: SessionRuntimeDeps,
    runtimeConfig?: SessionRuntimeConfig,
  ) {
    this.forkedAgentsEnabled = runtimeConfig?.forkedAgentsEnabled ?? true;
    this.hooksEnabled = runtimeConfig?.hooksEnabled ?? true;
    this.forkSemaphore = new ForkSemaphore(runtimeConfig?.maxConcurrentForks ?? 2);
    this.hookRegistry = new PostTurnHookRegistry(runtimeConfig?.hookTimeoutMs ?? 30_000);

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
      this.hookRegistry.register(createSessionMemoryHook(this.sessionMemory));
    }
  }

  hasActiveTurn() {
    return Boolean(this.activeTurn);
  }

  hasActiveWork(): boolean {
    return this.hasActiveTurn() || this.activeForkedAgents.size > 0;
  }

  registerForkedAgent(handle: ForkedAgentHandle): void {
    this.activeForkedAgents.set(handle.id, handle);
    handle.promise.finally(() => {
      this.activeForkedAgents.delete(handle.id);
    });
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
      await this.deps.rolloutRecorder.record({
        type: 'session_reseeded',
        conversationId: submission.conversationId,
        taskId: submission.requestId,
        data: {
          historyCount: submission.history.length,
        },
      });
    }

    const activeTurn = new ActiveTurn(submission.requestId, this.state.getNextTurnId());
    this.activeTurn = activeTurn;

    await this.deps.rolloutRecorder.record({
      type: 'task_started',
      conversationId: submission.conversationId,
      taskId: submission.requestId,
      turnId: activeTurn.turnId,
      data: {
        session: this.state.snapshot(),
        platformHistoryCount: submission.history.length,
      },
    });

    try {
      const result = await consumeGenerator(
        this.deps.turnExecutor.run(
          { ...submission, promptHistory: this.state.getPromptHistory() },
          undefined,
          activeTurn,
        ),
        (event) => events.push(event),
      );
      this.commitResult(submission, result, activeTurn);

      // Fire-and-forget: launch post-turn hooks AFTER committing result
      if (this.hooksEnabled && this.hookRegistry.size > 0) {
        this.hookRegistry.runAll({
          sessionState: this.state,
          sessionRuntime: this,
          forkSemaphore: this.forkSemaphore,
          turnExecutor: this.deps.turnExecutor,
          conversationId: submission.conversationId,
          lastResult: result,
        }).catch(() => {
          // Swallowed — hook errors never crash the main agent
        });
      }

      await this.deps.rolloutRecorder.record({
        type: 'task_completed',
        conversationId: submission.conversationId,
        taskId: submission.requestId,
        turnId: activeTurn.turnId,
        data: {
          result: {
            finalText: result.finalText,
            completedTurns: result.completedTurns,
            toolCallCount: result.toolCallCount,
            tokenUsage: result.tokenUsage,
          },
          session: this.state.snapshot(),
        },
      });
    } catch (error) {
      activeTurn.fail(error);
      await this.deps.rolloutRecorder.record({
        type: 'task_failed',
        conversationId: submission.conversationId,
        taskId: submission.requestId,
        turnId: activeTurn.turnId,
        data: {
          error: error instanceof Error ? error.message : String(error),
          turn: activeTurn.snapshot(),
        },
      });
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
    };
  }

  private commitResult(submission: TurnSubmission, result: TurnExecutionResult, activeTurn: ActiveTurn) {
    this.state.commitTask(submission.userMessage, result.finalText, result.promptMessages);
    activeTurn.complete(result.tokenUsage);
  }
}
