import { generateId, type Message } from '../../models/ModelClient.js';

export interface PostCompactRecoveryConfig {
  maxRecoveryTokens: number;
}

export interface RecoveryContext {
  characterContext?: string;
}

const BYTES_PER_TOKEN = 4;

export class PostCompactRecovery {
  constructor(private readonly config: PostCompactRecoveryConfig) {}

  buildRecoveryMessages(context: RecoveryContext): Message[] {
    if (!context.characterContext) {
      return [];
    }

    const tokenEstimate = Math.ceil(context.characterContext.length / BYTES_PER_TOKEN);
    if (tokenEstimate > this.config.maxRecoveryTokens) {
      // Truncate to budget
      const maxChars = this.config.maxRecoveryTokens * BYTES_PER_TOKEN;
      return [{
        role: 'user',
        content: `Additional context:\n${context.characterContext.slice(0, maxChars)}`,
        id: generateId(),
      }];
    }

    return [{
      role: 'user',
      content: `Additional context:\n${context.characterContext}`,
      id: generateId(),
    }];
  }
}
