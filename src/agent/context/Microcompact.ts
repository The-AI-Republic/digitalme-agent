import type { Message } from '../../models/ModelClient.js';
import type { MicrocompactConfig, MicrocompactResult } from './types.js';

const BYTES_PER_TOKEN = 4;

export class Microcompact {
  constructor(private readonly config: MicrocompactConfig) {}

  compact(messages: Message[]): MicrocompactResult {
    if (!this.shouldCompact(messages)) {
      return { messages, tokensFreed: 0, resultsCleared: 0 };
    }

    // Walk tool-role messages newest-to-oldest, track compactable tool results seen
    let compactableSeen = 0;
    let tokensFreed = 0;
    let resultsCleared = 0;
    const result = [...messages];

    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i];
      if (msg.role !== 'tool' || !msg.toolName || !msg.content) {
        continue;
      }
      if (!this.config.compactableTools.has(msg.toolName)) {
        continue;
      }

      compactableSeen++;
      if (compactableSeen <= this.config.keepRecentResults) {
        continue;
      }

      // Clear this old compactable tool result
      const freedChars = msg.content.length - this.config.clearedMarker.length;
      tokensFreed += Math.max(0, Math.ceil(freedChars / BYTES_PER_TOKEN));
      resultsCleared++;
      result[i] = { ...msg, content: this.config.clearedMarker };
    }

    return { messages: result, tokensFreed, resultsCleared };
  }

  private shouldCompact(messages: Message[]): boolean {
    // Find the last assistant message
    const lastAssistant = this.findLastAssistant(messages);
    if (!lastAssistant?.timestamp) {
      return false;
    }

    const gapMinutes = (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000;
    if (!Number.isFinite(gapMinutes) || gapMinutes < this.config.gapThresholdMinutes) {
      return false;
    }

    return true;
  }

  private findLastAssistant(messages: Message[]): Message | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        return messages[i];
      }
    }
    return undefined;
  }
}
