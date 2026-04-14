import type { Message, TokenUsage } from '../../models/ModelClient.js';
import type { PrepareContextResult } from './types.js';
import type { TokenBudget } from './TokenBudget.js';
import type { ToolResultPersistence } from './ToolResultPersistence.js';
import type { Microcompact } from './Microcompact.js';
import type { SessionMemoryCompact } from './SessionMemoryCompact.js';
import type { PromptProjector } from './PromptProjector.js';
import type { PostCompactRecovery, RecoveryContext } from './PostCompactRecovery.js';
import type { SessionMemory } from './SessionMemory.js';

export interface PrepareContextDeps {
  tokenBudget: TokenBudget;
  toolResultPersistence: ToolResultPersistence;
  microcompact: Microcompact;
  sessionMemoryCompact?: SessionMemoryCompact;
  promptProjector?: PromptProjector;
  postCompactRecovery?: PostCompactRecovery;
  sessionMemory?: SessionMemory;
  /** Set by CostAwareRouter when quota usage is high — triggers earlier/more aggressive compaction. */
  aggressiveCompaction?: boolean;
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

  // Step 4: Session memory compaction (when pressure is at projection or above,
  // or when aggressive compaction is signaled by cost-aware routing)
  const shouldCompact = pressure === 'projection' || pressure === 'overflow'
    || (deps.aggressiveCompaction && pressure === 'microcompact');
  if (shouldCompact) {
    if (deps.sessionMemoryCompact) {
      try {
        const compactResult = await deps.sessionMemoryCompact.tryCompact(currentMessages, modelName);
        if (compactResult) {
          const prevCount = currentMessages.length;
          rewrote = true;
          currentMessages = compactResult.messages;
          compactionType = 'projection';
          messagesRemoved += prevCount - currentMessages.length;
          tokensSaved += compactResult.preCompactTokens - compactResult.postCompactTokens;
        }
      } catch (error) {
        // Session memory compaction is best-effort; continue with existing messages
        console.warn('[prepareContext] Session memory compaction failed:', error);
      }
    }
  }

  // Step 5: Post-compact recovery (inject recovery context after compaction)
  if (compactionType === 'projection' && deps.postCompactRecovery && deps.sessionMemory) {
    try {
      const memory = await deps.sessionMemory.getMemory();
      const recoveryContext: RecoveryContext = {
        characterContext: memory?.text,
      };
      const recoveryMessages = deps.postCompactRecovery.buildRecoveryMessages(recoveryContext);
      if (recoveryMessages.length > 0) {
        currentMessages = [...currentMessages, ...recoveryMessages];
        rewrote = true;
      }
    } catch (error) {
      // Recovery is best-effort
      console.warn('[prepareContext] Post-compact recovery failed:', error);
    }
  }

  // Re-assess pressure after compaction
  const postCompactPressure = (compactionType && compactionType !== 'microcompact')
    ? deps.tokenBudget.assessPressure(modelName, currentMessages)
    : pressure;

  // Step 6: Prompt projection — when pressure remains high after compaction,
  // select a recent tail of messages that fits the context window
  let finalPressure = postCompactPressure;
  if (deps.promptProjector && (postCompactPressure === 'projection' || postCompactPressure === 'overflow')) {
    // Find the latest user message for projection input
    let latestUserMessage: Message | undefined;
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      if (currentMessages[i].role === 'user') {
        latestUserMessage = currentMessages[i];
        break;
      }
    }

    if (latestUserMessage) {
      // Get session memory content if available
      let sessionMemoryContent;
      if (deps.sessionMemory) {
        try {
          sessionMemoryContent = await deps.sessionMemory.getMemory() ?? undefined;
        } catch (error) {
          // best-effort
          console.warn('[prepareContext] Session memory fetch for projection failed:', error);
        }
      }

      const projected = deps.promptProjector.project({
        fullHistory: currentMessages,
        latestUserMessage,
        modelName,
        pressure: postCompactPressure,
        systemPromptTokenEstimate: 0, // Conservative — system prompt already in messages[0]
        sessionMemory: sessionMemoryContent,
      });

      if (projected.length < currentMessages.length) {
        const prevCount = currentMessages.length;
        currentMessages = projected;
        rewrote = true;
        messagesRemoved += prevCount - currentMessages.length;
        finalPressure = deps.tokenBudget.assessPressure(modelName, currentMessages);
      }
    }
  }

  return {
    messages: currentMessages,
    rewrote,
    pressure: finalPressure,
    messagesRemoved,
    tokensSaved,
    compactionType,
  };
}
