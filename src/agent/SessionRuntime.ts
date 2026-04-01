import type { AgentEvent, TurnExecutionResult, TurnSubmission } from './types.js';
import { ActiveTurn } from './ActiveTurn.js';
import { EventQueue } from './EventQueue.js';
import type { IRolloutRecorder } from './RolloutRecorder.js';
import { SessionState } from './SessionState.js';
import { TurnExecutor } from './TurnExecutor.js';

interface SessionRuntimeDeps {
  turnExecutor: Pick<TurnExecutor, 'run'>;
  rolloutRecorder: IRolloutRecorder;
}

export class SessionRuntime {
  private activeTurn?: ActiveTurn;

  constructor(
    readonly state: SessionState,
    private readonly deps: SessionRuntimeDeps,
  ) {}

  hasActiveTurn() {
    return Boolean(this.activeTurn);
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
      const result = await this.deps.turnExecutor.run({
        ...submission,
        promptHistory: this.state.getPromptHistory(),
      }, events, activeTurn);
      this.commitResult(submission, result, activeTurn);
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
    };
  }

  private commitResult(submission: TurnSubmission, result: TurnExecutionResult, activeTurn: ActiveTurn) {
    this.state.commitTask(submission.userMessage, result.finalText, result.promptMessages);
    activeTurn.complete(result.tokenUsage);
  }
}
