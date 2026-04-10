import type { HistoryMessage } from '../protocol/types.js';
import type { Message } from '../models/ModelClient.js';
import type { TurnSubmission } from './types.js';

export class TurnContext {
  public readonly requestId: string;
  public readonly conversationId: string;
  public readonly userMessage: string;
  public readonly history: HistoryMessage[];
  public readonly signal: AbortSignal | undefined;
  public readonly messages: Message[] = [];

  constructor(submission: TurnSubmission, initialMessages: Message[]) {
    this.requestId = submission.requestId;
    this.conversationId = submission.conversationId;
    this.userMessage = submission.userMessage;
    this.history = submission.history;
    this.signal = submission.signal;
    this.messages = [...initialMessages];
  }
}
