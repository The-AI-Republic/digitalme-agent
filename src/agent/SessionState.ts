import { generateId, type Message } from '../models/ModelClient.js';
import type { HistoryMessage } from '../protocol/types.js';
import type { ToolSummaryEntry } from './types.js';
import type { ConversationSummary } from './context/types.js';

function cloneMessage(message: Message): Message {
  const cloned: Message = {
    role: message.role,
    content: message.content,
    id: message.id,
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
  if (message.timestamp) {
    cloned.timestamp = message.timestamp;
  }
  if (message.synthetic) {
    cloned.synthetic = message.synthetic;
  }

  return cloned;
}

function historiesMatch(left: HistoryMessage[], right: HistoryMessage[]) {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other && other.role === item.role && other.content === item.content;
  });
}

function historyToMessages(history: HistoryMessage[]): Message[] {
  const now = new Date().toISOString();
  return history.map((item) => ({
    role: item.role,
    content: item.content,
    id: generateId(),
    timestamp: now,
  }));
}

export class SessionState {
  private messages: Message[] = [];
  /**
   * Tool-use summaries stored separately from model-facing prompt content.
   * Available for future prompt projection / compaction, not immediate model consumption.
   */
  private readonly toolUseSummaries: ToolSummaryEntry[] = [];
  private summary?: ConversationSummary;
  private nextTurnId = 1;
  private lastAccessedAt = Date.now();
  private readonly createdAt = Date.now();
  private revision = 0;

  constructor(
    readonly conversationId: string,
    history: HistoryMessage[],
  ) {
    this.messages = historyToMessages(history);
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

  getRevision(): number {
    return this.revision;
  }

  /** Full message history for LLM context. */
  getMessages(): Message[] {
    return this.messages.map(cloneMessage);
  }

  /**
   * Canonical view for platform reconciliation — computed, not stored.
   * Excludes tool-call assistant messages, tool results, and synthetic messages.
   */
  getCanonicalHistory(): HistoryMessage[] {
    return this.messages
      .filter(m =>
        (m.role === 'user' || m.role === 'assistant')
        && !m.toolCalls
        && !m.synthetic
      )
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' }));
  }

  reconcileWithPlatformHistory(history: HistoryMessage[]) {
    this.touch();
    const canonical = this.getCanonicalHistory();
    if (history.length === 0 && canonical.length > 0) {
      return 'warm' as const;
    }
    if (historiesMatch(canonical, history)) {
      return 'unchanged' as const;
    }
    this.messages = historyToMessages(history);
    this.summary = undefined;
    this.revision++;
    return 'reseeded' as const;
  }

  getSummary(): ConversationSummary | undefined {
    return this.summary;
  }

  setSummary(summary: ConversationSummary): void {
    this.summary = summary;
  }

  /** After a turn completes, append new messages. */
  appendMessages(newMessages: Message[], toolSummaries?: ToolSummaryEntry[]) {
    for (const msg of newMessages) {
      this.messages.push(cloneMessage(msg));
    }
    if (toolSummaries && toolSummaries.length > 0) {
      this.toolUseSummaries.push(...toolSummaries);
    }
    this.touch();
    this.revision++;
  }

  /** On resume, initialize from transcript. */
  initializeFromTranscript(messages: Message[]) {
    this.messages = messages.map(cloneMessage);
    this.revision++;
  }

  /** Tool-use summaries for future prompt projection. NOT model-facing. */
  getToolUseSummaries(): readonly ToolSummaryEntry[] {
    return this.toolUseSummaries;
  }

  /**
   * Destructive mutation — only safe if state hasn't advanced since the fork started.
   * Returns false if revision has advanced (caller should discard the stale result).
   */
  compactHistory(summary: string, startRevision: number): boolean {
    if (this.revision !== startRevision) {
      return false;
    }
    this.revision++;
    this.messages = [{
      role: 'assistant',
      content: summary,
      id: generateId(),
      synthetic: true,
    }];
    return true;
  }

  snapshot() {
    const canonical = this.getCanonicalHistory();
    return {
      conversationId: this.conversationId,
      createdAt: new Date(this.createdAt).toISOString(),
      lastAccessedAt: new Date(this.lastAccessedAt).toISOString(),
      canonicalHistoryCount: canonical.length,
      messageCount: this.messages.length,
      toolUseSummaryCount: this.toolUseSummaries.length,
      nextTurnId: this.nextTurnId,
      revision: this.revision,
    };
  }
}
