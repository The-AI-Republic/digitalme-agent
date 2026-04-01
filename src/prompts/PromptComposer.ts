import type { AgentConfig } from '../config/schema.js';
import type { Message } from '../models/ModelClient.js';

export class PromptComposer {
  constructor(
    private readonly config: AgentConfig,
    private readonly approvedTools: string[],
  ) {}

  compose(history: Message[], latestUserMessage: string): Message[] {
    const toolPolicy = this.approvedTools.length > 0
      ? `Approved tools: ${this.approvedTools.join(', ')}.`
      : 'Approved tools: none.';
    const messages: Message[] = [
      {
        role: 'system',
        content: `${this.config.persona.default_system_prompt}\n\n${toolPolicy}`,
      },
    ];
    messages.push(...history);

    messages.push({
      role: 'user',
      content: latestUserMessage,
    });

    return messages;
  }
}

export interface IPromptComposer {
  compose(history: Message[], latestUserMessage: string): Message[];
}
