import type { ForkSemaphore } from '../fork/ForkSemaphore.js';
import type { SessionState } from '../SessionState.js';
import type { TurnExecutionResult, ForkedAgentHandle, TurnExecutorLike } from '../types.js';
import type { ITranscriptRecorder, HookExecutedEntry, HookOutcome } from '../transcript/types.js';
import type { SpanContext } from '@opentelemetry/api';
import { startHookSpan, endSpan, endSpanWithError } from '../../telemetry/spans.js';
import { recordHook } from '../../telemetry/metrics.js';

export class HookTimeoutError extends Error {
  override readonly name = 'HookTimeoutError';
  constructor() {
    super('Hook execution timed out');
  }
}

export const SLOW_HOOK_THRESHOLD_MS = 2000;

export interface PostTurnHookContext {
  sessionState: SessionState;
  sessionRuntime: { canFork(): boolean; registerForkedAgent(handle: ForkedAgentHandle): void };
  forkSemaphore: ForkSemaphore;
  turnExecutor: TurnExecutorLike;
  transcriptRecorder?: ITranscriptRecorder;
  conversationId: string;
  lastResult: TurnExecutionResult;
  interactionSpanContext?: SpanContext;
}

export type PostTurnHook = (context: PostTurnHookContext) => Promise<void>;

export class PostTurnHookRegistry {
  private readonly hooks: Array<{ fn: PostTurnHook; name: string }> = [];
  private readonly timeoutMs: number;
  private readonly transcriptRecorder?: ITranscriptRecorder;

  constructor(timeoutMs = 30_000, transcriptRecorder?: ITranscriptRecorder) {
    this.timeoutMs = timeoutMs;
    this.transcriptRecorder = transcriptRecorder;
  }

  register(hook: PostTurnHook, name?: string): void {
    this.hooks.push({ fn: hook, name: name ?? `hook_${this.hooks.length}` });
  }

  unregister(hook: PostTurnHook): void {
    const index = this.hooks.findIndex((h) => h.fn === hook);
    if (index !== -1) {
      this.hooks.splice(index, 1);
    }
  }

  async runAll(context: PostTurnHookContext): Promise<void> {
    const recorder = context.transcriptRecorder ?? this.transcriptRecorder;

    for (const { fn, name } of this.hooks) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const startTime = Date.now();
      let outcome: HookOutcome = 'success';
      let errorMsg: string | undefined;

      // Start a linked root span for this hook (if interaction context is available)
      const hookSpan = context.interactionSpanContext
        ? startHookSpan(name, context.interactionSpanContext)
        : undefined;

      try {
        await Promise.race([
          fn(context),
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new HookTimeoutError()), this.timeoutMs);
          }),
        ]);
      } catch (error) {
        if (error instanceof HookTimeoutError) {
          outcome = 'timeout';
          errorMsg = 'Hook execution timed out';
        } else {
          outcome = 'error';
          errorMsg = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      const durationMs = Date.now() - startTime;

      // End hook span
      if (hookSpan) {
        const spanAttrs = { 'hook.name': name, 'hook.outcome': outcome, 'hook.duration_ms': durationMs };
        if (outcome === 'success') {
          endSpan(hookSpan, spanAttrs);
        } else {
          endSpanWithError(hookSpan, errorMsg ?? 'unknown error', spanAttrs);
        }
      }

      // Record metric
      recordHook(name, outcome);

      // Record hook_executed — never crash the main agent
      if (recorder) {
        try {
          const entry: HookExecutedEntry = {
            type: 'hook_executed',
            conversationId: context.conversationId,
            timestamp: new Date().toISOString(),
            hookName: name,
            outcome,
            durationMs,
            error: errorMsg,
          };
          await recorder.recordLifecycleEvent(entry);
        } catch {
          // Recording failures must not crash the agent
        }
      }
    }
  }

  get size(): number {
    return this.hooks.length;
  }
}
