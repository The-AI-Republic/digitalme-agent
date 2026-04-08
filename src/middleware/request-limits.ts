import type { AgentConfig } from '../config/schema.js';
import type { TurnRequest } from '../protocol/types.js';

export function validateTurnLimits(config: AgentConfig, payload: TurnRequest) {
  if (payload.message.length > config.limits.max_message_length) {
    throw new Error('message_too_long');
  }
  if (payload.history.length > config.limits.max_history_messages) {
    throw new Error('history_too_long');
  }
  for (const entry of payload.history) {
    if (entry.content.length > config.limits.max_message_length) {
      throw new Error('history_message_too_long');
    }
  }
}
