import type { Message } from '../../models/ModelClient.js';
import type { AssistantToolGroup } from './types.js';

const BYTES_PER_TOKEN = 4;

function estimateMessageTokens(msg: Message): number {
  let chars = 0;
  if (msg.content) {
    chars += msg.content.length;
  }
  if (msg.toolCalls) {
    for (const call of msg.toolCalls) {
      chars += call.function.name.length + call.function.arguments.length;
    }
  }
  return Math.ceil(chars / BYTES_PER_TOKEN);
}

/**
 * Groups a message array into atomic compaction units.
 *
 * An assistant message with toolCalls[] plus all its matching tool result
 * messages form one group. Plain text messages (user, assistant without tools,
 * system) are each their own group of size 1.
 */
export function groupMessages(messages: Message[]): AssistantToolGroup[] {
  const groups: AssistantToolGroup[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Collect the tool call IDs from this assistant message
      const callIds = new Set(msg.toolCalls.map((c) => c.id));
      let endIndex = i;
      let tokens = estimateMessageTokens(msg);

      // Consume following tool-role messages that belong to this assistant message
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool' && messages[j].toolCallId && callIds.has(messages[j].toolCallId!)) {
        tokens += estimateMessageTokens(messages[j]);
        endIndex = j;
        j++;
      }

      groups.push({
        startIndex: i,
        endIndex,
        messageCount: endIndex - i + 1,
        estimatedTokens: tokens,
      });
      i = endIndex + 1;
    } else {
      // Single-message group (user, system, plain assistant text, or orphaned tool)
      groups.push({
        startIndex: i,
        endIndex: i,
        messageCount: 1,
        estimatedTokens: estimateMessageTokens(msg),
      });
      i++;
    }
  }

  return groups;
}
