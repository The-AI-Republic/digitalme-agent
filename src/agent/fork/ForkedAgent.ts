import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ExecutionOptions,
  ForkedAgentConfig,
  ForkedAgentHandle,
  ForkedAgentResult,
  TurnExecutorLike,
  TurnSubmission,
} from '../types.js';
import { consumeGenerator } from '../types.js';
import type { ForkSemaphore } from './ForkSemaphore.js';
import type {
  ITranscriptRecorder,
  ForkStartedEntry,
  ForkCompletedEntry,
  ForkFailedEntry,
  ForkRejectedEntry,
} from '../transcript/types.js';
import type { SpanContext } from '@opentelemetry/api';
import { startForkSpan, endSpan, endSpanWithError } from '../../telemetry/spans.js';
import { recordFork } from '../../telemetry/metrics.js';

interface ForkedAgentLifecycle {
  canFork(): boolean;
  registerForkedAgent(handle: ForkedAgentHandle): void;
}

export interface LaunchForkedAgentParams {
  submission: TurnSubmission;
  turnExecutor: TurnExecutorLike;
  options?: ExecutionOptions;
  sessionRuntime: ForkedAgentLifecycle;
  forkSemaphore: ForkSemaphore;
  onResult?: (result: ForkedAgentResult) => void | Promise<void>;
  config: ForkedAgentConfig;
  transcriptRecorder?: ITranscriptRecorder;
  interactionSpanContext?: SpanContext;
}

/**
 * Single entry point for spawning a background fork.
 *
 * Owns semaphore acquire/release, abort wiring, handle registration,
 * result delivery, and cleanup.
 *
 * Returns `null` if the semaphore is full (caller should skip).
 */
export function launchForkedAgent(params: LaunchForkedAgentParams): ForkedAgentHandle | null {
  const { forkSemaphore, sessionRuntime, turnExecutor, config, submission, options, onResult, transcriptRecorder, interactionSpanContext } = params;

  if (!sessionRuntime.canFork()) {
    recordFork(config.forkLabel, 'rejected');
    // Record rejection: forks disabled
    if (transcriptRecorder) {
      const rejectedEntry: ForkRejectedEntry = {
        type: 'fork_rejected',
        conversationId: submission.conversationId,
        taskId: submission.requestId,
        timestamp: new Date().toISOString(),
        forkLabel: config.forkLabel,
        reason: 'forks_disabled',
      };
      transcriptRecorder.recordLifecycleEvent(rejectedEntry).catch(() => {});
    }
    return null;
  }

  if (!forkSemaphore.tryAcquire()) {
    recordFork(config.forkLabel, 'rejected');
    // Record rejection: semaphore full
    if (transcriptRecorder) {
      const rejectedEntry: ForkRejectedEntry = {
        type: 'fork_rejected',
        conversationId: submission.conversationId,
        taskId: submission.requestId,
        timestamp: new Date().toISOString(),
        forkLabel: config.forkLabel,
        reason: 'semaphore_full',
      };
      transcriptRecorder.recordLifecycleEvent(rejectedEntry).catch(() => {});
    }
    return null;
  }

  const forkId = `fork-${config.forkLabel}-${randomUUID()}`;

  const childAbort = new AbortController();
  if (submission.signal) {
    if (submission.signal.aborted) {
      childAbort.abort();
    } else {
      submission.signal.addEventListener('abort', () => childAbort.abort(), { once: true });
    }
  }

  // Record fork_started
  if (transcriptRecorder) {
    const startedEntry: ForkStartedEntry = {
      type: 'fork_started',
      conversationId: submission.conversationId,
      taskId: submission.requestId,
      timestamp: new Date().toISOString(),
      forkId,
      forkLabel: config.forkLabel,
    };
    transcriptRecorder.recordLifecycleEvent(startedEntry).catch(() => {});
  }

  const startTime = Date.now();

  // Start a linked root span for the fork (if interaction context is available)
  const forkSpan = interactionSpanContext
    ? startForkSpan(config.forkLabel, interactionSpanContext)
    : undefined;

  const promise = (async (): Promise<ForkedAgentResult> => {
    try {
      const result = await consumeGenerator(
        turnExecutor.run(
          { ...submission, signal: childAbort.signal },
          options,
        ),
        (_event: AgentEvent) => { /* discard — forked agents are silent */ },
      );

      // Record sidechain transcript unless skipTranscript is set
      if (transcriptRecorder && !config.skipTranscript && result.newMessages.length > 0) {
        try {
          await transcriptRecorder.insertMessageChain(
            submission.conversationId,
            result.newMessages,
            true,  // isSidechain
            forkId,
          );
          await transcriptRecorder.writeAgentMetadata(submission.conversationId, {
            agentId: forkId,
            agentType: 'fork',
            description: config.forkLabel,
            createdAt: new Date().toISOString(),
          });
        } catch {
          // Best effort — recording failure should not block fork completion
        }
      }

      const forkedResult: ForkedAgentResult = {
        totalUsage: result.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finalText: result.finalText,
      };

      const durationMs = Date.now() - startTime;

      // Record fork_completed
      if (transcriptRecorder) {
        const completedEntry: ForkCompletedEntry = {
          type: 'fork_completed',
          conversationId: submission.conversationId,
          taskId: submission.requestId,
          timestamp: new Date().toISOString(),
          forkId,
          forkLabel: config.forkLabel,
          tokenUsage: forkedResult.totalUsage,
          durationMs,
          toolCallCount: result.toolCallCount,
        };
        transcriptRecorder.recordLifecycleEvent(completedEntry).catch(() => {});
      }

      // End fork span
      if (forkSpan) {
        endSpan(forkSpan, {
          'fork.duration_ms': durationMs,
          'fork.tool_call_count': result.toolCallCount,
        });
      }

      recordFork(config.forkLabel, 'success');
      await onResult?.(forkedResult);
      return forkedResult;
    } catch (error) {
      recordFork(config.forkLabel, 'failed');
      // Record fork_failed
      if (transcriptRecorder) {
        const failedEntry: ForkFailedEntry = {
          type: 'fork_failed',
          conversationId: submission.conversationId,
          taskId: submission.requestId,
          timestamp: new Date().toISOString(),
          forkId,
          forkLabel: config.forkLabel,
          error: error instanceof Error ? error.message : String(error),
        };
        transcriptRecorder.recordLifecycleEvent(failedEntry).catch(() => {});
      }

      // End fork span with error
      if (forkSpan) {
        endSpanWithError(forkSpan, error, { 'fork.duration_ms': Date.now() - startTime });
      }

      throw error;
    } finally {
      forkSemaphore.release();
    }
  })();

  // Suppress unhandled rejection — fork errors are fire-and-forget.
  // Callers that care about errors can await handle.promise directly.
  promise.catch(() => {});

  const handle: ForkedAgentHandle = {
    id: forkId,
    forkLabel: config.forkLabel,
    abort: () => childAbort.abort(),
    promise,
  };

  sessionRuntime.registerForkedAgent(handle);

  return handle;
}
