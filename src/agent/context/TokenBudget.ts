import type { Message, TokenUsage } from '../../models/ModelClient.js';
import type { PressureBand, TokenBudgetConfig, ModelMetadata } from './types.js';

const BYTES_PER_TOKEN = 4;

export class TokenBudget {
  constructor(private readonly config: TokenBudgetConfig) {}

  getEffectiveWindow(modelName: string): number {
    const meta = this.resolveModelMetadata(modelName);
    return meta.contextWindowSize - meta.maxOutputTokens;
  }

  estimateTokens(messages: Message[], lastKnownUsage?: TokenUsage): number {
    if (lastKnownUsage) {
      return lastKnownUsage.inputTokens + lastKnownUsage.outputTokens;
    }
    return this.estimateFromContent(messages);
  }

  assessPressure(modelName: string, messages: Message[], lastKnownUsage?: TokenUsage): PressureBand {
    const effectiveWindow = this.getEffectiveWindow(modelName);
    const estimated = this.estimateTokens(messages, lastKnownUsage);

    if (estimated > effectiveWindow * this.config.overflowRatio) {
      return 'overflow';
    }
    if (estimated > effectiveWindow * this.config.projectionRatio) {
      return 'projection';
    }
    if (estimated > effectiveWindow * this.config.microcompactRatio) {
      return 'microcompact';
    }
    return 'nominal';
  }

  private resolveModelMetadata(modelName: string): ModelMetadata {
    const meta = this.config.modelMetadata[modelName];
    if (meta) {
      return meta;
    }
    return {
      contextWindowSize: this.config.defaultContextWindowSize,
      maxOutputTokens: this.config.defaultMaxOutputTokens,
    };
  }

  private estimateFromContent(messages: Message[]): number {
    let totalChars = 0;
    for (const msg of messages) {
      if (msg.content) {
        totalChars += msg.content.length;
      }
      if (msg.toolCalls) {
        for (const call of msg.toolCalls) {
          totalChars += call.function.name.length + call.function.arguments.length;
        }
      }
    }
    const rawEstimate = Math.ceil(totalChars / BYTES_PER_TOKEN);
    return Math.ceil(rawEstimate * this.config.safetyMargin);
  }
}
