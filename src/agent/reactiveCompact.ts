import type { Message } from '../models/ModelClient.js';

/**
 * Group messages into complete request/response rounds.
 *
 * Each round starts with a user message and includes the assistant response
 * plus all tool result messages until the next user message. The system
 * prompt (messages[0]) is always its own group.
 *
 * Example transcript:
 *   system, user1, assistant1, tool1a, tool1b, user2, assistant2, user3, assistant3
 * Produces:
 *   [system] [user1, assistant1, tool1a, tool1b] [user2, assistant2] [user3, assistant3]
 *
 * Dropping group [user1, assistant1, tool1a, tool1b] removes a complete round
 * without orphaning tool results or separating a request from its response.
 */
export function groupByRound(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && current.length > 0) {
      groups.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Minimal reactive compaction: drop complete request/response rounds from the
 * middle of the transcript, keeping the system prompt and last 2 rounds.
 *
 * Returns true if compaction was performed, false if there wasn't enough
 * history to compact meaningfully.
 */
export function tryReactiveCompact(messages: Message[]): boolean {
  const groups = groupByRound(messages);
  // system + 1 round + current = 3 groups minimum, nothing to drop
  if (groups.length <= 3) return false;

  // Keep first group (system prompt) and last 2 round groups (recent context).
  const keep = [groups[0]!, ...groups.slice(-2)].flat();
  messages.length = 0;
  messages.push(...keep);
  return true;
}
