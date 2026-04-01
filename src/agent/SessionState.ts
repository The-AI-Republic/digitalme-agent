import type { Message } from '../models/ModelClient.js';
import type { HistoryMessage } from '../protocol/types.js';

function clonePromptMessage(message: Message): Message {
  const cloned: Message = {
    role: message.role,
    content: message.content,
  };

  if (message.toolCallId) {
    cloned.toolCallId = message.toolCallId;
  }
  if (message.toolName) {
    cloned.toolName = message.toolName;
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    cloned.toolCalls = message.toolCalls.map((call) => ({
      id: call.id,
      type: call.type,
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    }));
  }

  return cloned;
}

function historiesMatch(left: HistoryMessage[], right: HistoryMessage[]) {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other && other.role === item.role && other.content === item.content;
  });
}

function canonicalToPromptHistory(history: HistoryMessage[]): Message[] {
  return history.map((item) => ({
    role: item.role,
    content: item.content,
  }));
}

export class SessionState {
  private canonicalHistory: HistoryMessage[];
  private promptHistory: Message[];
  private nextTurnId = 1;
  private lastAccessedAt = Date.now();
  private readonly createdAt = Date.now();

  constructor(
    readonly conversationId: string,
    history: HistoryMessage[],
  ) {
    this.canonicalHistory = history.map((item) => ({ ...item }));
    this.promptHistory = canonicalToPromptHistory(history);
  }

  touch() {
    this.lastAccessedAt = Date.now();
  }

  getLastAccessedAt() {
    return this.lastAccessedAt;
  }

  getNextTurnId() {
    const turnId = this.nextTurnId;
    this.nextTurnId += 1;
    return turnId;
  }

  getPromptHistory(): Message[] {
    return this.promptHistory.map(clonePromptMessage);
  }

  getCanonicalHistory(): HistoryMessage[] {
    return this.canonicalHistory.map((item) => ({ ...item }));
  }

  reconcileWithPlatformHistory(history: HistoryMessage[]) {
    this.touch();
    if (history.length === 0 && this.canonicalHistory.length > 0) {
      return 'warm' as const;
    }
    if (historiesMatch(this.canonicalHistory, history)) {
      return 'unchanged' as const;
    }
    this.canonicalHistory = history.map((item) => ({ ...item }));
    this.promptHistory = canonicalToPromptHistory(history);
    return 'reseeded' as const;
  }

  commitTask(userMessage: string, finalText: string, promptMessages: Message[]) {
    this.touch();
    this.canonicalHistory.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: finalText },
    );
    for (const message of promptMessages) {
      this.promptHistory.push(clonePromptMessage(message));
    }
  }

  snapshot() {
    return {
      conversationId: this.conversationId,
      createdAt: new Date(this.createdAt).toISOString(),
      lastAccessedAt: new Date(this.lastAccessedAt).toISOString(),
      canonicalHistoryCount: this.canonicalHistory.length,
      promptHistoryCount: this.promptHistory.length,
      nextTurnId: this.nextTurnId,
    };
  }
}
