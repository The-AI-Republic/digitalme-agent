# Recovery and Continuation

## Goal

Make request execution continuation and retry behavior explicit, bounded, and inspectable.

This track should make `digitalme-agent` better at:

- recovering from model API errors and context overflow
- continuing long responses cleanly when output is truncated
- avoiding retry death spirals
- recording why the runtime took another loop iteration
- gracefully degrading instead of hard-failing

## Current State

The main request loop lives in `src/agent/TurnExecutor.ts` (lines 47-115). The loop structure is:

```
while (turnCount < max_turns) {
  result = client.generate(...)
  if result is final_text → return
  if result is tool_calls → execute tools → continue
}
throw max_turns_exceeded
```

**What is missing today:**

- No retry on model API errors — a single 429/529/5xx kills the entire request
- No context overflow handling — full history is always sent, no compaction
- No token-aware limits — only message count limits exist
- No max-output recovery — truncated output is flagged but not continued
- No continuation tracking — no record of why an iteration happened
- No fallback model support
- No graceful degradation — `max_turns` is a hard error, not a graceful conclusion

## Claudy Patterns Worth Borrowing

### Source References

| File | Purpose |
|------|---------|
| `claudy/src/query.ts` | Main query loop, recovery orchestration (lines 219-1730) |
| `claudy/src/query/transitions.ts` | Terminal and Continue reason types |
| `claudy/src/query/tokenBudget.ts` | Token budget continuation logic |
| `claudy/src/services/compact/autoCompact.ts` | Proactive compaction, circuit breaker |
| `claudy/src/services/api/withRetry.ts` | API retry loop, fallback trigger |
| `claudy/src/services/api/errors.ts` | Error categorization |

### Key Architectural Insight: Distributed Recovery, Not Centralized

Claudy does **not** use a centralized recovery manager. Recovery logic is distributed inline within the loop, with each recovery path following the same pattern:

1. Check guards/counters (e.g., `hasAttemptedReactiveCompact`, `maxOutputTokensRecoveryCount < 3`)
2. Update state with appropriate counters incremented
3. Set `state.transition = { reason: 'specific_reason' }` — explicit continuation reason
4. `continue` to next iteration

This works because each recovery path is small (10-20 lines) and the guard checks prevent infinite loops. A centralized manager would add indirection without reducing complexity.

**Recommendation for digitalme:** Follow the distributed pattern. The loop in `TurnExecutor.ts` is already simple enough that inline recovery paths will be readable. A centralized `RecoveryManager` is unnecessary unless the loop grows beyond 5-6 recovery paths.

### Explicit Transition Tracking

Claudy tracks a `transition` field on loop state. Every `continue` statement assigns a reason:

**Terminal reasons** (loop returns):
- `completed` — normal completion (model gave final text, no tool calls)
- `max_turns` — turn limit reached
- `prompt_too_long` — 413 error, recovery exhausted
- `model_error` — unrecoverable API failure
- `aborted_streaming` — user/caller cancelled during streaming
- `aborted_tools` — user/caller cancelled during tool execution

**Continuation reasons** (loop iterates again):
- `tool_use` — model returned tool calls (normal flow)
- `reactive_compact_retry` — compacted context after 413, retrying
- `max_output_tokens_recovery` — model truncated mid-response, resuming
- `max_output_tokens_escalate` — bumping output limit from low default to full
- `collapse_drain_retry` — drained staged context collapses after overflow

### Bounded Recovery With Guards

Every recovery path in claudy has an explicit bound:

| Recovery | Guard | Limit |
|----------|-------|-------|
| Reactive compact | `hasAttemptedReactiveCompact` boolean | 1 attempt |
| Max-output recovery | `maxOutputTokensRecoveryCount` counter | 3 attempts |
| Collapse drain | `transition.reason !== 'collapse_drain_retry'` | 1 attempt |
| Auto-compact failures | `consecutiveFailures` counter | 3 then circuit-break |
| API 529 fallback | `consecutive529Errors` counter | 3 then trigger fallback |

Pattern: boolean flags for one-shot recovery, integer counters for bounded multi-attempt recovery. Circuit breakers (stop trying entirely) for paths that keep failing.

### Error Withholding During Streaming

Claudy captures recoverable errors (413, max_output_tokens) during streaming but does **not** yield them to the consumer immediately. Recovery logic runs post-streaming. Only if recovery fails does the error get surfaced.

This prevents the caller from seeing transient errors that the loop can handle internally.

### Proactive vs Reactive Compaction

- **Proactive:** fires before each API call when token count approaches threshold (context window minus 13k buffer). Uses circuit breaker after 3 consecutive failures.
- **Reactive:** fires after a 413 error. One-shot attempt to summarize and strip media to get under limit. Guarded by `hasAttempted` flag.

## Target Design for DigitalMe Agent

### New Type Definitions

**File:** `src/agent/types/recovery.ts`

```typescript
// --- Continuation reasons (why the loop iterated again) ---

export type ContinuationReason =
  | { reason: 'tool_use'; toolNames: string[] }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_recovery'; attempt: number }
  | { reason: 'api_retry'; attempt: number; errorType: ApiErrorCategory }
  | { reason: 'fallback_model'; fromModel: string; toModel: string };

// --- Terminal reasons (why the loop stopped) ---

export type TerminalReason =
  | { reason: 'completed' }
  | { reason: 'max_turns' }
  | { reason: 'prompt_too_long' }
  | { reason: 'model_error'; error: string }
  | { reason: 'aborted'; phase: 'streaming' | 'tools' }
  | { reason: 'max_output_exhausted' };

// --- API error categories (for retry decisions) ---

export type ApiErrorCategory =
  | 'rate_limit'       // 429
  | 'overloaded'       // 529
  | 'server_error'     // 5xx
  | 'context_overflow'  // 413
  | 'auth_error'       // 401/403
  | 'unknown';

// --- Recovery state tracked across loop iterations ---

export interface RecoveryState {
  hasAttemptedReactiveCompact: boolean;
  maxOutputRecoveryCount: number;
  apiRetryCount: number;
  fallbackAttempted: boolean;
  lastTransition: ContinuationReason | undefined;
}

export const RECOVERY_LIMITS = {
  MAX_OUTPUT_RECOVERY_ATTEMPTS: 3,
  MAX_API_RETRIES: 3,
  FALLBACK_AFTER_CONSECUTIVE_529: 3,
} as const;

export function initialRecoveryState(): RecoveryState {
  return {
    hasAttemptedReactiveCompact: false,
    maxOutputRecoveryCount: 0,
    apiRetryCount: 0,
    fallbackAttempted: false,
    lastTransition: undefined,
  };
}
```

### Changes to TurnExecutor Loop

**File:** `src/agent/TurnExecutor.ts`

The loop gains recovery state and inline recovery paths. Pseudocode for the new structure:

```typescript
async run(context, events, activeTurn?) {
  const recovery = initialRecoveryState();

  while (context.turnCount < this.config.limits.max_turns) {
    this.throwIfAborted(context.signal);
    context.turnCount += 1;

    // --- Call model (with error capture, not immediate throw) ---
    const result = await this.callModelWithRecovery(context, recovery);

    // --- Handle context overflow (413) ---
    if (result.type === 'context_overflow') {
      if (!recovery.hasAttemptedReactiveCompact) {
        const compacted = await this.tryReactiveCompact(context);
        if (compacted) {
          recovery.hasAttemptedReactiveCompact = true;
          recovery.lastTransition = { reason: 'reactive_compact_retry' };
          events.push({ type: 'recovery', reason: 'reactive_compact_retry' });
          continue;
        }
      }
      // Recovery exhausted
      events.push({ type: 'done', terminalReason: { reason: 'prompt_too_long' } });
      return result;
    }

    // --- Handle max output truncation ---
    if (result.type === 'final_text' && result.truncated) {
      if (recovery.maxOutputRecoveryCount < RECOVERY_LIMITS.MAX_OUTPUT_RECOVERY_ATTEMPTS) {
        recovery.maxOutputRecoveryCount += 1;
        context.messages.push({
          role: 'user',
          content: 'Output limit reached. Resume exactly where you stopped.',
        });
        recovery.lastTransition = {
          reason: 'max_output_recovery',
          attempt: recovery.maxOutputRecoveryCount,
        };
        events.push({ type: 'recovery', reason: 'max_output_recovery' });
        continue;
      }
      // Exhausted — return what we have
      events.push({ type: 'done', terminalReason: { reason: 'max_output_exhausted' } });
      return result;
    }

    // --- Normal final text ---
    if (result.type === 'final_text') {
      events.push({ type: 'done', terminalReason: { reason: 'completed' } });
      return result;
    }

    // --- Tool calls (normal continuation) ---
    for (const call of result.calls) {
      const toolResult = await this.executeTool(call, context, events);
      context.messages.push(toolResult);
    }
    recovery.lastTransition = {
      reason: 'tool_use',
      toolNames: result.calls.map(c => c.name),
    };
    // Reset per-iteration counters that should not persist across tool continuations
    recovery.apiRetryCount = 0;
  }

  // Max turns reached
  events.push({ type: 'done', terminalReason: { reason: 'max_turns' } });
  throw new Error('max_turns_exceeded');
}
```

### API Retry With Fallback

**New method on TurnExecutor** or extracted to a helper:

```typescript
private async callModelWithRecovery(
  context: TurnContext,
  recovery: RecoveryState,
): Promise<ModelStepResult | { type: 'context_overflow' }> {
  let consecutive529 = 0;

  for (let attempt = 0; attempt <= RECOVERY_LIMITS.MAX_API_RETRIES; attempt++) {
    try {
      return await this.client.generate({ messages: context.messages });
    } catch (error) {
      const category = categorizeApiError(error);

      if (category === 'context_overflow') {
        return { type: 'context_overflow' };
      }

      if (category === 'overloaded') {
        consecutive529++;
        if (consecutive529 >= RECOVERY_LIMITS.FALLBACK_AFTER_CONSECUTIVE_529
            && this.config.fallbackModel
            && !recovery.fallbackAttempted) {
          recovery.fallbackAttempted = true;
          this.client.switchModel(this.config.fallbackModel);
          recovery.lastTransition = {
            reason: 'fallback_model',
            fromModel: this.config.model,
            toModel: this.config.fallbackModel,
          };
          continue;
        }
      }

      if ((category === 'rate_limit' || category === 'overloaded' || category === 'server_error')
          && attempt < RECOVERY_LIMITS.MAX_API_RETRIES) {
        await exponentialBackoff(attempt);
        recovery.apiRetryCount++;
        recovery.lastTransition = {
          reason: 'api_retry',
          attempt: attempt + 1,
          errorType: category,
        };
        continue;
      }

      throw error; // Non-retryable or retries exhausted
    }
  }

  throw new Error('api_retries_exhausted');
}
```

### New Events for Observability

Extend `AgentEvent` in `src/agent/types.ts`:

```typescript
export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; name: string; callId: string }
  | { type: 'tool_end'; name: string; callId: string; success: boolean }
  | { type: 'done'; truncated?: boolean; tokenUsage?: TokenUsage; terminalReason?: TerminalReason }
  | { type: 'error'; message: string }
  // New:
  | { type: 'recovery'; reason: string; detail?: Record<string, unknown> };
```

The `recovery` event makes every extra loop iteration visible to callers, rollout recording, and any future observability tooling.

### Reactive Compaction (Minimal First Pass)

Full compaction (track 03) is a separate improvement track. For this track, implement a minimal reactive compaction that:

1. Counts tokens in `context.messages` (use tiktoken or model's tokenizer)
2. When triggered by 413, truncates old messages from the middle of history (keep system prompt + last N exchanges)
3. If a summarization model call is available, replace truncated messages with a summary

This is intentionally simple. A richer compaction system belongs in its own track. The goal here is that the recovery path exists and is wired, even if the compaction strategy is basic.

```typescript
private async tryReactiveCompact(context: TurnContext): Promise<boolean> {
  const messageCount = context.messages.length;
  if (messageCount <= 4) return false; // Nothing to compact

  // Keep system prompt (first) + last 2 exchanges (last 4 messages)
  // Summarize or drop everything in between
  const keep = [context.messages[0], ...context.messages.slice(-4)];
  context.messages.length = 0;
  context.messages.push(...keep);
  return true;
}
```

## Implementation Sequence

### Step 1: Recovery Types

**Files:**
- New: `src/agent/types/recovery.ts`
- Update: `src/agent/types.ts` (add `recovery` event, `TerminalReason` to `done`)

**Work:**
- Define `ContinuationReason`, `TerminalReason`, `ApiErrorCategory`
- Define `RecoveryState` interface and `initialRecoveryState()`
- Define `RECOVERY_LIMITS` constants
- Add `recovery` event type and `terminalReason` to existing `AgentEvent`

**Why first:** Types are the foundation. Getting them right means every subsequent step has a clear contract.

### Step 2: API Error Categorization and Retry

**Files:**
- New: `src/agent/apiRetry.ts`
- Update: `src/agent/TurnExecutor.ts`

**Work:**
- Implement `categorizeApiError(error): ApiErrorCategory`
- Implement `exponentialBackoff(attempt: number): Promise<void>`
- Extract model call into `callModelWithRecovery()` with bounded retry loop
- Wire fallback model support (config field + runtime switch)

**Why second:** API retry is the most impactful recovery path. Today a single 429 kills the entire request. This fixes that without touching the loop structure.

### Step 3: Continuation Tracking in the Loop

**Files:**
- Update: `src/agent/TurnExecutor.ts`

**Work:**
- Add `RecoveryState` to the loop
- Record `lastTransition` on every `continue`
- Emit `recovery` events when non-tool continuations happen
- Add `terminalReason` to the `done` event
- Record tool names in `tool_use` continuation reason

**Why third:** This is the observability backbone. After this step, every loop iteration has a recorded reason.

### Step 4: Max-Output Continuation

**Files:**
- Update: `src/agent/TurnExecutor.ts`

**Work:**
- Detect `truncated: true` on `final_text` results
- Inject continuation message and re-enter loop
- Bound by `maxOutputRecoveryCount < 3`
- Emit `recovery` event with attempt number
- Surface `max_output_exhausted` terminal reason when bound is hit

**Why fourth:** Max-output truncation is already detected (the `truncated` flag exists). This step uses it.

### Step 5: Reactive Compaction (Minimal)

**Files:**
- New: `src/agent/reactiveCompact.ts`
- Update: `src/agent/TurnExecutor.ts`

**Work:**
- Detect 413 / context_overflow from model client
- Implement minimal compaction (drop middle history, keep bookends)
- Guard with `hasAttemptedReactiveCompact` (one-shot)
- Emit `recovery` event
- Surface `prompt_too_long` terminal reason when compaction fails or was already attempted

**Why last:** Context overflow is less common than API errors or output truncation for digitalme's typical workloads (shorter conversations than a coding agent). The recovery path matters more than the compaction quality — quality improves in track 03.

## Testing Strategy

### Unit Tests

**Recovery state transitions:**
- `initialRecoveryState()` returns all zeroes/false
- After max-output recovery, `maxOutputRecoveryCount` increments
- After reactive compact, `hasAttemptedReactiveCompact` is true
- After fallback, `fallbackAttempted` is true

**API error categorization:**
- 429 → `rate_limit`
- 529 → `overloaded`
- 413 → `context_overflow`
- 5xx → `server_error`
- 401/403 → `auth_error`

**Bounded retries:**
- API retry stops at `MAX_API_RETRIES` (3), then throws
- Max-output recovery stops at 3, then returns with `max_output_exhausted`
- Reactive compact runs at most once per request
- Fallback triggers after 3 consecutive 529s, at most once

### Integration Tests

**End-to-end recovery scenarios:**
- Model returns 429 twice then succeeds → request completes, 2 `recovery` events emitted
- Model returns 529 three times with fallback configured → switches model, request completes
- Model returns truncated output → continuation message injected, model completes on retry
- Model returns 413 → compaction runs, retries once, completes
- Model returns 413 after compaction already attempted → `prompt_too_long` terminal reason

**State consistency:**
- Recovery counters reset appropriately between tool-use continuations vs persist across recovery continuations
- `lastTransition` always reflects the actual reason for the current iteration
- Events stream includes `recovery` events in correct order

### Observability Verification

- `done` event always includes `terminalReason`
- Every non-first loop iteration has a recorded `lastTransition`
- Recovery events are visible in rollout recordings

## Risks

| Risk | Mitigation |
|------|------------|
| Recovery branches making the loop unreadable | Keep each path to 10-20 lines inline. Extract to helper only if it exceeds this. Claudy manages 6+ paths inline in ~700 lines without issue. |
| Retries mutating prompt state inconsistently | `RecoveryState` is the single source of truth for what has been attempted. Guards prevent double-attempts. |
| Retry backoff being too slow for user-facing agent | Keep backoff short (100ms, 200ms, 400ms). Digitalme is public-facing — latency matters more than persistence. |
| Fallback model producing different quality output | Document in agent config. Fallback is opt-in. Creator chooses acceptable fallback. |
| Compaction losing important context | Minimal compaction (step 5) is intentionally conservative — drops middle history, keeps recent. Better compaction belongs in track 03. |
| Adding retry before the model client properly surfaces error types | Step 2 starts with `categorizeApiError()` — a single place to handle error shape differences across providers. |

## Success Criteria

- Every loop iteration has a recorded continuation or terminal reason
- API errors (429, 529, 5xx) are retried up to 3 times with backoff before failing
- Truncated output is automatically continued up to 3 times
- Context overflow triggers one compaction attempt before failing
- All recovery paths are bounded and cannot loop indefinitely
- Recovery events are visible in the event stream and rollout recordings
- No regression in normal (no-error) request latency
