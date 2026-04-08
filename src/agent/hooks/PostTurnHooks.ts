import type { TurnExecutor } from '../TurnExecutor.js';
import type { ForkSemaphore } from '../fork/ForkSemaphore.js';
import type { SessionState } from '../SessionState.js';
import type { TurnExecutionResult, ForkedAgentHandle } from '../types.js';

export interface PostTurnHookContext {
  sessionState: SessionState;
  sessionRuntime: { registerForkedAgent(handle: ForkedAgentHandle): void };
  forkSemaphore: ForkSemaphore;
  turnExecutor: { run: TurnExecutor['run'] };
  conversationId: string;
  lastResult: TurnExecutionResult;
}

export type PostTurnHook = (context: PostTurnHookContext) => Promise<void>;

export class PostTurnHookRegistry {
  private readonly hooks: PostTurnHook[] = [];
  private readonly timeoutMs: number;

  constructor(timeoutMs = 30_000) {
    this.timeoutMs = timeoutMs;
  }

  register(hook: PostTurnHook): void {
    this.hooks.push(hook);
  }

  unregister(hook: PostTurnHook): void {
    const index = this.hooks.indexOf(hook);
    if (index !== -1) {
      this.hooks.splice(index, 1);
    }
  }

  async runAll(context: PostTurnHookContext): Promise<void> {
    for (const hook of this.hooks) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          hook(context),
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error('hook_timeout')), this.timeoutMs);
          }),
        ]);
      } catch {
        // Swallow — never crash the main agent
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  get size(): number {
    return this.hooks.length;
  }
}
