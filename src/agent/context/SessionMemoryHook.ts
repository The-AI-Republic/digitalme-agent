import type { PostTurnHookContext } from '../hooks/PostTurnHooks.js';
import type { SessionMemory } from './SessionMemory.js';
import { buildExtractionPrompt } from './SessionMemoryPrompt.js';
import { launchForkedAgent } from '../fork/ForkedAgent.js';

const BYTES_PER_TOKEN = 4;

/**
 * Creates a post-turn hook that triggers session memory extraction
 * via a forked agent when thresholds are met.
 *
 * The forked agent receives the conversation history plus an extraction prompt,
 * and returns updated session notes as its finalText. The onResult callback
 * writes the notes to disk via SessionMemory.completeExtraction().
 */
export function createSessionMemoryHook(sessionMemory: SessionMemory) {
  return async (hookContext: PostTurnHookContext): Promise<void> => {
    const { sessionState, lastResult } = hookContext;

    // Count tool calls from this turn
    sessionMemory.incrementToolCalls(lastResult.toolCallCount);

    // Estimate current token count from last result
    const currentTokens = lastResult.tokenUsage?.totalTokens ??
      Math.ceil((lastResult.finalText?.length ?? 0) / BYTES_PER_TOKEN);

    if (!sessionMemory.shouldExtract(currentTokens)) {
      return;
    }

    const promptHistory = sessionState.getMessages();
    const lastMessage = promptHistory[promptHistory.length - 1];

    // Get current notes (or template if first extraction)
    const existing = await sessionMemory.getMemory();
    const currentNotes = existing?.text ?? sessionMemory.getCurrentTemplate();

    sessionMemory.startExtraction(currentTokens, lastMessage?.id);

    // Build extraction submission
    const extractionPrompt = buildExtractionPrompt(currentNotes);

    const handle = launchForkedAgent({
      submission: {
        requestId: `sm-extract-${Date.now()}`,
        conversationId: hookContext.conversationId,
        userMessage: extractionPrompt,
        history: [],
        promptHistory,
        signal: undefined,
      },
      turnExecutor: hookContext.turnExecutor,
      options: {
        maxTurns: 1,
        maxOutputTokens: 4096,
      },
      sessionRuntime: hookContext.sessionRuntime,
      forkSemaphore: hookContext.forkSemaphore,
      config: { forkLabel: 'session_memory' },
      transcriptRecorder: hookContext.transcriptRecorder,
      interactionSpanContext: hookContext.interactionSpanContext,
      onResult: async (result) => {
        if (result.finalText) {
          await sessionMemory.completeExtraction(result.finalText);
        }
      },
    });

    if (handle) {
      sessionMemory.setExtractionPromise(
        handle.promise.then(() => {}).catch(() => {}),
      );
    }
  };
}
