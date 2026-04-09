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
  const { forkSemaphore, sessionRuntime, turnExecutor, config, submission, options, onResult } = params;

  if (!sessionRuntime.canFork()) {
    return null;
  }

  if (!forkSemaphore.tryAcquire()) {
    return null;
  }

  const childAbort = new AbortController();
  if (submission.signal) {
    submission.signal.addEventListener('abort', () => childAbort.abort(), { once: true });
  }

  const promise = (async (): Promise<ForkedAgentResult> => {
    try {
      const result = await consumeGenerator(
        turnExecutor.run(
          { ...submission, signal: childAbort.signal },
          options,
        ),
        (_event: AgentEvent) => { /* discard — forked agents are silent */ },
      );
      const forkedResult: ForkedAgentResult = {
        totalUsage: result.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finalText: result.finalText,
      };
      await onResult?.(forkedResult);
      return forkedResult;
    } finally {
      forkSemaphore.release();
    }
  })();

  // Suppress unhandled rejection — fork errors are fire-and-forget.
  // Callers that care about errors can await handle.promise directly.
  promise.catch(() => {});

  const handle: ForkedAgentHandle = {
    id: `fork-${config.forkLabel}-${randomUUID()}`,
    forkLabel: config.forkLabel,
    abort: () => childAbort.abort(),
    promise,
  };

  sessionRuntime.registerForkedAgent(handle);

  return handle;
}
