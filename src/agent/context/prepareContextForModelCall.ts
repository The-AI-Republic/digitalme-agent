import type { Message, TokenUsage } from '../../models/ModelClient.js';
import type { PrepareContextResult } from './types.js';
import type { TokenBudget } from './TokenBudget.js';
import type { ToolResultPersistence } from './ToolResultPersistence.js';
import type { Microcompact } from './Microcompact.js';

export interface PrepareContextDeps {
  tokenBudget: TokenBudget;
  toolResultPersistence: ToolResultPersistence;
  microcompact: Microcompact;
}

/**
 * Per-model-step context preparation pipeline.
 * Runs before every client.generate() call inside the ReAct loop.
 *
 * Steps:
 * 1. Enforce tool result persistence budget
 * 2. Run microcompact (clear stale tool results)
 * 3. Assess token pressure
 * 4. (Future: projection and compaction — Steps 3-4 will extend this)
 */
export async function prepareContextForModelCall(
  messages: Message[],
  modelName: string,
  lastKnownUsage: TokenUsage | undefined,
  conversationId: string,
  deps: PrepareContextDeps,
): Promise<PrepareContextResult> {
  let rewrote = false;
  let currentMessages = messages;
  let messagesRemoved = 0;
  let tokensSaved = 0;
  let compactionType: 'microcompact' | 'projection' | 'reactive' | undefined;

  const messageCountBefore = currentMessages.length;

  // Step 1: Enforce per-message tool result budget
  const budgetEnforced = await deps.toolResultPersistence.enforceMessageBudget(
    currentMessages,
    conversationId,
  );
  if (budgetEnforced !== currentMessages) {
    rewrote = true;
    currentMessages = budgetEnforced;
  }

  // Step 2: Microcompact — clear stale compactable tool results
  const mcResult = deps.microcompact.compact(currentMessages);
  if (mcResult.resultsCleared > 0) {
    rewrote = true;
    currentMessages = mcResult.messages;
    compactionType = 'microcompact';
    tokensSaved = mcResult.tokensFreed;
    messagesRemoved = messageCountBefore - currentMessages.length;
  }

  // Step 3: Assess pressure (invalidate baseline if we rewrote)
  const effectiveUsage = rewrote ? undefined : lastKnownUsage;
  const pressure = deps.tokenBudget.assessPressure(modelName, currentMessages, effectiveUsage);

  // Steps 4-6 (projection, compaction, recovery) will be added in Steps 3-4

  return {
    messages: currentMessages,
    rewrote,
    pressure,
    messagesRemoved,
    tokensSaved,
    compactionType,
  };
}
