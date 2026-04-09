import type { Message } from '../../models/ModelClient.js';
import type { ModelStepResult } from '../../models/ModelClient.js';

export interface MaxOutputRecoveryConfig {
  maxRetries: number;
  escalatedMaxTokens?: number;
}

const DEFAULT_CONTINUATION_PROMPT =
  'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened. Keep your response concise.';

export class MaxOutputRecovery {
  private recoveryCount = 0;

  constructor(private readonly config: MaxOutputRecoveryConfig) {}

  isTruncated(result: ModelStepResult): boolean {
    return result.type === 'final_text' && result.truncated === true;
  }

  canRetry(): boolean {
    return this.recoveryCount < this.config.maxRetries;
  }

  buildContinuationMessage(): Message {
    this.recoveryCount++;
    return {
      role: 'user',
      content: DEFAULT_CONTINUATION_PROMPT,
    };
  }

  getEscalatedMaxTokens(): number | undefined {
    if (this.recoveryCount === 0 && this.config.escalatedMaxTokens) {
      return this.config.escalatedMaxTokens;
    }
    return undefined;
  }

  resetForNewTurn(): void {
    this.recoveryCount = 0;
  }
}
