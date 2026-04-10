import type { Message } from '../../models/ModelClient.js';
import type { CompactionResult } from './types.js';
import type { SessionMemory } from './SessionMemory.js';
import type { TokenBudget } from './TokenBudget.js';
import { groupMessages } from './groupMessages.js';

export interface SessionMemoryCompactConfig {
  minTokens: number;
  minTextBlockMessages: number;
  maxTokens: number;
}

export class SessionMemoryCompact {
  constructor(
    private readonly config: SessionMemoryCompactConfig,
    private readonly sessionMemory: SessionMemory,
    private readonly tokenBudget: TokenBudget,
  ) {}

  async tryCompact(messages: Message[], modelName: string): Promise<CompactionResult | null> {
    // Wait for in-progress extraction
    await this.sessionMemory.waitForExtraction(15_000);

    const memory = await this.sessionMemory.getMemory();
    if (!memory) {
      return null;
    }

    const groups = groupMessages(messages);
    if (groups.length === 0) {
      return null;
    }

    // Find the group containing lastSummarizedMessageId
    const lastSummarizedId = this.sessionMemory.getLastSummarizedMessageId();
    let keepFromGroupIndex = 0;

    if (lastSummarizedId) {
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        for (let i = group.startIndex; i <= group.endIndex; i++) {
          if (messages[i].id === lastSummarizedId) {
            keepFromGroupIndex = g;
            break;
          }
        }
      }
    }

    // Expand backward by whole groups to meet minTokens and minTextBlockMessages
    let keptTokens = 0;
    let keptTextMessages = 0;
    let actualKeepFrom = groups.length;

    for (let g = groups.length - 1; g >= keepFromGroupIndex; g--) {
      const group = groups[g];
      keptTokens += group.estimatedTokens;

      // Count text-block messages in this group
      for (let i = group.startIndex; i <= group.endIndex; i++) {
        if (messages[i].content && messages[i].role !== 'tool') {
          keptTextMessages++;
        }
      }

      actualKeepFrom = g;

      if (keptTokens >= this.config.minTokens && keptTextMessages >= this.config.minTextBlockMessages) {
        break;
      }

      if (keptTokens >= this.config.maxTokens) {
        break;
      }
    }

    // Build compacted messages
    const keepStartIndex = groups[actualKeepFrom]?.startIndex ?? 0;
    const preserved = messages.slice(keepStartIndex);

    const preCompactTokens = this.tokenBudget.estimateTokens(messages);
    const compactedMessages: Message[] = [
      {
        role: 'assistant',
        content: `[Context compacted. Pre-compact tokens: ~${preCompactTokens}]\n\n${memory.text}`,
      },
      ...preserved,
    ];
    const postCompactTokens = this.tokenBudget.estimateTokens(compactedMessages);

    return {
      messages: compactedMessages,
      preCompactTokens,
      postCompactTokens,
    };
  }
}
