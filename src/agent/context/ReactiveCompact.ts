import { generateId, type Message } from '../../models/ModelClient.js';
import type { ConversationSummary } from './types.js';
import type { ConversationSummaryBuilder } from './ConversationSummaryBuilder.js';
import type { PostCompactRecovery, RecoveryContext } from './PostCompactRecovery.js';

export interface ReactiveCompactConfig {
  maxRetries: number;
  aggressivePreserveMessages: number;
}

export interface ReactiveCompactResult {
  messages: Message[];
  summary: ConversationSummary;
  succeeded: boolean;
}

export class ReactiveCompact {
  private hasAttempted = false;

  constructor(
    private readonly config: ReactiveCompactConfig,
    private readonly summaryBuilder: ConversationSummaryBuilder,
    private readonly postCompactRecovery: PostCompactRecovery,
  ) {}

  canAttempt(): boolean {
    return !this.hasAttempted;
  }

  resetForNewTurn(): void {
    this.hasAttempted = false;
  }

  async recover(
    messages: Message[],
    recoveryContext: RecoveryContext,
  ): Promise<ReactiveCompactResult> {
    this.hasAttempted = true;

    // Summarize everything except the last N messages
    const cutoff = Math.max(0, messages.length - this.config.aggressivePreserveMessages);
    const summary = await this.summaryBuilder.summarize(messages, cutoff);

    const preserved = messages.slice(cutoff);

    // Build recovery messages
    const recoveryMessages = this.postCompactRecovery.buildRecoveryMessages(recoveryContext);

    const compacted: Message[] = [
      {
        role: 'assistant',
        content: `[Emergency compaction]\n\n${summary.text}`,
        id: generateId(),
        synthetic: true,
      },
      ...recoveryMessages,
      ...preserved,
    ];

    return {
      messages: compacted,
      summary,
      succeeded: true,
    };
  }
}
