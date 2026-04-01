import type { TokenUsage } from '../models/ModelClient.js';
import { TurnState } from './TurnState.js';

type ActiveTurnStatus = 'running' | 'completed' | 'failed';

export class ActiveTurn {
  readonly startedAt = new Date().toISOString();
  readonly turnState = new TurnState();
  private status: ActiveTurnStatus = 'running';
  private errorMessage?: string;
  private completedAt?: string;

  constructor(
    readonly taskId: string,
    readonly turnId: number,
  ) {}

  complete(tokenUsage?: TokenUsage) {
    this.turnState.setTokenUsage(tokenUsage);
    this.status = 'completed';
    this.completedAt = new Date().toISOString();
  }

  fail(error: unknown) {
    this.status = 'failed';
    this.errorMessage = error instanceof Error ? error.message : String(error);
    this.completedAt = new Date().toISOString();
  }

  snapshot() {
    return {
      taskId: this.taskId,
      turnId: this.turnId,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      status: this.status,
      errorMessage: this.errorMessage,
      turnState: this.turnState.snapshot(),
    };
  }
}
