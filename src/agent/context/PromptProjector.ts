import { generateId, type Message } from '../../models/ModelClient.js';
import type { ConversationSummary, SessionMemoryContent, PressureBand } from './types.js';
import type { TokenBudget } from './TokenBudget.js';

const BYTES_PER_TOKEN = 4;

export interface ProjectionConfig {
  recentTailMinMessages: number;
  recentTailMaxTokens: number;
}

export interface ProjectionInput {
  summary?: ConversationSummary;
  sessionMemory?: SessionMemoryContent;
  fullHistory: Message[];
  latestUserMessage: Message;
  modelName: string;
  systemPromptTokenEstimate: number;
  pressure: PressureBand;
}

export class PromptProjector {
  constructor(
    private readonly config: ProjectionConfig,
    private readonly tokenBudget: TokenBudget,
  ) {}

  project(input: ProjectionInput): Message[] {
    const { pressure, fullHistory, latestUserMessage, modelName, systemPromptTokenEstimate } = input;

    // In nominal or microcompact bands, just pass history through
    if (pressure === 'nominal' || pressure === 'microcompact') {
      return [...fullHistory, latestUserMessage];
    }

    // Projection needed — use session memory or summary
    const contextText = this.getContextText(input);
    const availableBudget = this.tokenBudget.getEffectiveWindow(modelName) - systemPromptTokenEstimate;

    const result: Message[] = [];

    // Insert context block if we have one
    if (contextText) {
      const contextMessage: Message = {
        role: 'user',
        content: `Context from earlier conversation:\n${contextText}`,
        id: generateId(),
      };
      result.push(contextMessage);
    }

    // Determine recent tail
    const recentTail = this.selectRecentTail(fullHistory, availableBudget, contextText);
    result.push(...recentTail);

    // Always include latest user message
    result.push(latestUserMessage);

    return result;
  }

  private getContextText(input: ProjectionInput): string | undefined {
    // Prefer session memory over summary
    if (input.sessionMemory) {
      return input.sessionMemory.text;
    }
    if (input.summary) {
      return input.summary.text;
    }
    return undefined;
  }

  private selectRecentTail(
    history: Message[],
    availableBudget: number,
    contextText: string | undefined,
  ): Message[] {
    // Reserve budget for context block
    let remainingBudget = availableBudget;
    if (contextText) {
      remainingBudget -= Math.ceil(contextText.length / BYTES_PER_TOKEN);
    }
    // Reserve some for the latest user message
    remainingBudget -= 500; // rough reserve

    const tail: Message[] = [];
    let tailTokens = 0;

    // Walk backwards from end of history
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = Math.ceil((msg.content?.length ?? 0) / BYTES_PER_TOKEN);

      if (tailTokens + msgTokens > remainingBudget && tail.length >= this.config.recentTailMinMessages) {
        break;
      }

      if (tailTokens + msgTokens > this.config.recentTailMaxTokens) {
        break;
      }

      tail.unshift(msg);
      tailTokens += msgTokens;
    }

    return tail;
  }
}
