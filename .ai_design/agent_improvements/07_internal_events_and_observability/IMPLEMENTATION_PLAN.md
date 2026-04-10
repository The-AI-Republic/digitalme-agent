# Internal Events and Observability

## Goal

Improve operational visibility without changing the external SSE protocol.

This track should make `digitalme-agent` better at:

- debugging request execution
- measuring tool/runtime behavior
- supporting future internal hook points
- tracking forked agent and subagent lifecycle
- observing post-turn hook execution

## Current State

### What Tracks Have Landed

Tracks 01 (prompt management), 08 (forked/subagents), and major parts of tracks 02–06 have shipped. The codebase is substantially more mature than when this design doc was first written. This section captures the observability-relevant infrastructure that now exists.

### Public SSE Protocol (unchanged)

The `AgentEvent` union (`src/agent/types.ts`) defines the public-facing stream:

- `text_delta` — streaming text chunks
- `tool_start` / `tool_end` — tool lifecycle (name, callId, success)
- `done` — turn completion with optional `terminalReason` and `tokenUsage`
- `error` — general errors
- `recovery` — recovery attempt events (reason + detail)

The `recovery` event is new since the original doc. It emits for `api_retry`, `fallback_model`, `max_output_recovery`, and `reactive_compact_retry`.

### TranscriptRecorder (replaces RolloutRecorder)

`TranscriptRecorder` (`src/agent/transcript/TranscriptRecorder.ts`) has replaced `RolloutRecorder` as the primary persistence layer. It is significantly more capable:

- **Message-level recording** with `parentId` chain tracking for message lineage
- **Lifecycle events** via `recordLifecycleEvent()`: `task_started`, `task_completed`, `task_failed`, `session_reseeded`
- **Sidechain support** for subagent message chains (`isSidechain`, `agentId`)
- **Artifact references** for externalized tool results
- **Deduplication** via per-conversation Set loaded from disk
- **Transcript recovery** — `loadTranscript()` enables cold-start session recovery

Event types are defined in `src/agent/transcript/types.ts` with typed interfaces: `TaskStartedEntry`, `TaskCompletedEntry`, `TaskFailedEntry`, `SessionReseededEntry`, `MessageEntry`.

Note: `RolloutRecorder.ts` still exists but is no longer used by `SessionRuntime` or `TurnExecutor`. It should be removed or formally deprecated.

### Dual-Write Pattern in TurnExecutor

`TurnExecutor` (`src/agent/TurnExecutor.ts`, now 542 lines) dual-writes to both the `AgentEvent` async generator stream and `TranscriptRecorder`:

- User message → `recorder.recordMessage()`
- Assistant final text → `recorder.recordMessage()`
- Assistant tool-call message → `recorder.recordMessage()`
- Tool result message → `recorder.recordMessage()` with `parentOverride` and `artifactRef`

This means **every message** in the conversation is persisted to the transcript with chain metadata.

### Recovery Infrastructure (from Track 04)

`src/agent/types/recovery.ts` defines typed reasons for continuation and termination:

- **ContinuationReason**: `tool_use`, `reactive_compact_retry`, `max_output_recovery`, `api_retry`, `fallback_model`
- **TerminalReason**: `completed`, `max_turns`, `prompt_too_long`, `model_error`, `aborted`, `max_output_exhausted`
- **ApiErrorCategory**: `rate_limit`, `overloaded`, `server_error`, `context_overflow`, `auth_error`, `unknown`
- **RecoveryState**: tracks attempt counts, accumulated text, fallback status

These are emitted as `AgentEvent.recovery` events from `TurnExecutor.callModelWithRecovery()`.

### ToolExecutor (from Track 03)

`ToolExecutor` (`src/tools/execution/ToolExecutor.ts`) is a centralized tool execution engine with:

- **Callbacks**: `onToolStart(name, callId)` / `onToolEnd(name, callId, success)` — used by `TurnExecutor` to emit `AgentEvent` and update `TurnExecutionState`
- **ToolExecutionRecord**: full execution record with `args`, `result` (NormalizedToolResult), `modelContent`, `durationMs`, `summary`
- **Error categorization**: `ToolErrorCategory` — `validation_error`, `policy_rejected`, `timeout`, `execution_error`, `aborted`, `unknown_tool`
- **Concurrency**: up to 5 concurrent tool executions
- **ResultBudget**: per-request budget tracking for tool result sizes

### Runtime Store and Observers (from Track 06)

- **RuntimeStore** (`src/agent/RuntimeStore.ts`): minimal `createStore(initialState, onChange)` with `Object.is` short-circuit
- **ProcessRuntimeState** (`src/agent/ProcessRuntimeState.ts`): `activeRequestCount` + `draining`
- **RuntimeObservers** (`src/agent/RuntimeObservers.ts`): `createRuntimeObservers(listeners)` with field-diff checks for `onActiveRequestCountChanged` and `onDrainingChanged`
- **Agent** owns the store; is the sole writer

### TurnExecutionState (from Track 06)

`TurnExecutionState` (`src/agent/TurnExecutionState.ts`) replaced `TurnState`, tracking:

- `iterationIndex`, `modelTurnCount`, `toolCallCount`
- `pendingToolCallIds` (Set)
- `tokenUsage`

`ActiveTurn` holds a `TurnExecutionState` and provides `snapshot()`.

### Context Management (from Track 02)

- **TokenBudget** — pressure bands (`nominal`, `microcompact`, `projection`, `overflow`)
- **Microcompact** — clears stale tool results to reduce token pressure
- **ToolResultPersistence** — externalizes large tool results to disk with artifact references
- **PromptProjector** — projects messages to fit within budget
- **ReactiveCompact** — last-resort compaction on 413 errors
- **SessionMemory** — optional extraction of conversation summaries between turns

### What Is Observable Today

| Layer | What's Recorded | Where |
|-------|----------------|-------|
| Process | `activeRequestCount`, `draining` changes | RuntimeObservers listeners |
| Task lifecycle | `task_started`, `task_completed`, `task_failed`, `session_reseeded` | TranscriptRecorder |
| Message chain | Every user/assistant/tool message with parentId | TranscriptRecorder |
| Tool execution | `tool_start`, `tool_end` events + `ToolExecutionRecord` summaries | AgentEvent stream + ToolSummaryEntry |
| Recovery | `api_retry`, `fallback_model`, `max_output_recovery`, `reactive_compact_retry` | AgentEvent.recovery |
| Iteration state | `iterationIndex`, `toolCallCount`, `tokenUsage` | TurnExecutionState.snapshot() |

### What Is NOT Observable Today

1. **Forked agent lifecycle** — `ForkedAgent.ts` discards all events (`(_event) => { /* discard */ }`). No visibility into fork start, completion, failure, or semaphore contention.

2. **Subagent lifecycle** — `SubagentTool.ts` discards all events. No visibility into subagent start, completion, failure, model used, or tools invoked.

3. **Post-turn hook execution** — `PostTurnHooks.ts` swallows all errors silently (`catch {}`). No distinction between timeout and other failures. No hook start/end tracking.

4. **Iteration-level events** — `TurnExecutor` tracks state via `TurnExecutionState` but doesn't emit discrete `iteration_started` / `iteration_completed` events. The only iteration-level signal is indirect: tool events and recovery events imply iteration boundaries, but there's no explicit event marking "iteration 3 started."

5. **Context pressure events** — `prepareContextForModelCall()` returns `PressureBand` and compaction results, but these are not surfaced as events. No visibility into when microcompact runs, when projection fires, or when overflow is detected (except as a `recovery` event for reactive compact).

6. **Session eviction** — `SessionManager.evictExpiredSessions()` and `evictToCapacity()` run silently. No events for which sessions were evicted or why.

7. **RolloutRecorder status** — still exists in the codebase but appears unused. Creates ambiguity about the recording path.

## Remaining Gap Analysis

Given what now exists, the original goal of "richer internal observability" is already **substantially achieved** at the task and message level by `TranscriptRecorder`, and at the recovery level by `AgentEvent.recovery`. The remaining gaps are:

### Gap 1: Silent Child Execution (HIGH priority)

Forked agents and subagents run via `TurnExecutor.run()` but discard all `AgentEvent` output. This means:

- A forked memory extraction that fails silently is invisible
- A subagent that burns tokens retrying is invisible
- Semaphore contention (fork rejected because slots are full) is invisible

### Gap 2: Silent Hook Execution (MEDIUM priority)

Post-turn hooks catch and swallow all errors. A hook that consistently times out will never be noticed without manual investigation.

### Gap 3: No Iteration Boundary Events (LOW priority)

Most of the value here is already captured by recovery events and tool events. Explicit iteration boundaries would help with debugging, but the ROI is lower than it was before recovery events existed.

### Gap 4: Context Pressure Visibility (LOW priority)

Context management decisions (microcompact, projection, pressure bands) happen silently. These would be useful for debugging long conversations that behave unexpectedly, but they're not blocking.

## Target Design

### Approach: Extend Existing Infrastructure

Rather than introducing new event types or systems, extend the existing patterns:

1. **TranscriptRecorder** for persisted observability (already the primary sink)
2. **AgentEvent stream** for real-time observability (already the primary stream)
3. **Callbacks** for execution-time side effects (the ToolExecutor pattern)

No new event bus. No new event type system. The existing `TranscriptEntry.type` union and `AgentEvent` union are the right extension points.

### Files To Change

- `src/agent/fork/ForkedAgent.ts` — capture and record child events
- `src/agent/subagent/SubagentTool.ts` — capture and record child events
- `src/agent/hooks/PostTurnHooks.ts` — add observability to hook execution
- `src/agent/transcript/types.ts` — extend lifecycle event types
- `src/agent/SessionRuntime.ts` — minor: record fork/subagent lifecycle

### Files To Remove

- `src/agent/RolloutRecorder.ts` — superseded by TranscriptRecorder

## Suggested Implementation Sequence

### Step 1: Remove RolloutRecorder

Files:
- delete `src/agent/RolloutRecorder.ts`
- remove any remaining imports

Work:
- verify no code path still references `IRolloutRecorder` or `RolloutRecorder`
- clean up any test files that reference it

### Step 2: Forked Agent Observability

Files:
- `src/agent/fork/ForkedAgent.ts`
- `src/agent/transcript/types.ts`
- `src/agent/SessionRuntime.ts`

Work:
- Add new transcript lifecycle types:
  ```typescript
  interface ForkStartedEntry extends TranscriptEntry {
    type: 'fork_started';
    forkId: string;
    forkLabel: string;
  }
  interface ForkCompletedEntry extends TranscriptEntry {
    type: 'fork_completed';
    forkId: string;
    forkLabel: string;
    tokenUsage: TokenUsage;
  }
  interface ForkFailedEntry extends TranscriptEntry {
    type: 'fork_failed';
    forkId: string;
    forkLabel: string;
    error: string;
  }
  interface ForkRejectedEntry extends TranscriptEntry {
    type: 'fork_rejected';
    forkLabel: string;
    reason: 'semaphore_full' | 'forks_disabled';
  }
  ```
- Thread `ITranscriptRecorder` into `launchForkedAgent()` params
- Record `fork_started` after semaphore acquire
- Record `fork_completed` / `fork_failed` in the promise handler
- Record `fork_rejected` when `tryAcquire()` returns false or `canFork()` returns false
- Optionally: instead of discarding events, use `insertMessageChain()` with `isSidechain: true` and `agentId: handle.id` to record forked agent messages (the infrastructure already exists)
- Update `TranscriptEntry.type` union to include the new types

### Step 3: Subagent Observability

Files:
- `src/agent/subagent/SubagentTool.ts`
- `src/agent/transcript/types.ts`

Work:
- Add new transcript lifecycle types:
  ```typescript
  interface SubagentStartedEntry extends TranscriptEntry {
    type: 'subagent_started';
    subagentType: string;
    model: string;
    toolCount: number;
  }
  interface SubagentCompletedEntry extends TranscriptEntry {
    type: 'subagent_completed';
    subagentType: string;
    tokenUsage?: TokenUsage;
    toolCallCount: number;
    completedTurns: number;
  }
  interface SubagentFailedEntry extends TranscriptEntry {
    type: 'subagent_failed';
    subagentType: string;
    error: string;
  }
  ```
- Thread `ITranscriptRecorder` into `SubagentToolDeps`
- Record lifecycle events around the `consumeGenerator()` call
- Optionally: use `insertMessageChain()` with `isSidechain: true` and `agentId: requestId` to record subagent messages instead of discarding them
- Update `TranscriptEntry.type` union

### Step 4: Post-Turn Hook Observability

Files:
- `src/agent/hooks/PostTurnHooks.ts`
- `src/agent/transcript/types.ts` (optional — could use existing lifecycle event types)

Work:
- Add optional `ITranscriptRecorder` to `PostTurnHookRegistry` constructor
- In `runAll()`, distinguish timeout from other errors:
  ```typescript
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === 'hook_timeout';
    // Record hook failure with reason
  }
  ```
- Record `hook_failed` / `hook_timeout` as lifecycle events
- Keep fire-and-forget semantics — recording failures should not crash the main agent

### Step 5: Clean Up and Verify

Work:
- Ensure `TranscriptEntry.type` union is exhaustive and all new types are covered
- Verify transcript files contain fork/subagent/hook events in integration tests
- Verify the public `AgentEvent` stream is unchanged

## What This Track Does NOT Do

- **No new event bus or pub/sub system** — extends existing `TranscriptRecorder` and `AgentEvent` patterns
- **No iteration-level events** — the recovery events already cover the interesting cases; explicit iteration boundaries can be added later if needed
- **No context pressure events** — useful but lower priority; the `PressureBand` data exists in `prepareContextForModelCall()` return values and can be surfaced later
- **No metrics system** — `RuntimeObservers` provides the hook point; a real metrics implementation (Prometheus/OpenTelemetry) is out of scope
- **No change to the public SSE protocol** — all new events are internal (transcript only)

## Dependency on Other Tracks

- **Track 06 (Runtime State and Observers)**: Implemented. `RuntimeStore`, `ProcessRuntimeState`, `RuntimeObservers`, `TurnExecutionState` are all in place.
- **Track 05 (Transcript and Artifact Storage)**: `TranscriptRecorder` is implemented and is the primary extension point for this track.
- **Track 04 (Recovery and Continuation)**: Implemented. Recovery events already flow through `AgentEvent.recovery`.
- **Track 03 (Tool Runtime)**: Implemented. `ToolExecutor` with callbacks and `ToolExecutionRecord` provides tool-level observability.

## Testing Strategy

Add tests for:

- `fork_started` / `fork_completed` / `fork_failed` / `fork_rejected` appear in transcript for forked agent runs
- `subagent_started` / `subagent_completed` / `subagent_failed` appear in transcript for subagent runs
- hook timeout produces a distinct event from hook failure
- fork rejection records the correct reason (`semaphore_full` vs `forks_disabled`)
- subagent event includes `subagentType`, model, and tool count
- no new events appear in the public `AgentEvent` stream (SSE contract unchanged)
- if sidechain recording is implemented: forked/subagent messages appear with `isSidechain: true`

## Risks

- **Threading `ITranscriptRecorder` through too many modules** — forked agent and subagent modules currently have no recorder dependency. Adding it increases coupling. Mitigated by passing it as an optional field in existing params/deps interfaces.
- **Sidechain recording volume** — recording full message chains for every fork and subagent could produce large transcript files. Mitigated by making sidechain recording opt-in via `ForkedAgentConfig.skipTranscript` (already exists) and a similar flag for subagents.
- **Hook recording failures** — if `TranscriptRecorder` itself fails during hook error recording, the double-failure should not propagate. Wrap in try-catch.

## Success Criteria

- Forked agent execution is visible in transcript logs without code changes
- Subagent execution is visible in transcript logs without code changes
- Post-turn hook failures and timeouts are distinguishable in transcript logs
- `RolloutRecorder` is removed from the codebase
- The public SSE protocol (`AgentEvent`) is unchanged
- No new event bus or pub/sub infrastructure is introduced

---

## Reference Analysis: How Claudy Solves the Same Problems

> Source: `/home/irichard/dev/study/claudy/src`
>
> Claudy (Claude Code) is a mature agent runtime that has already shipped solutions for the same observability gaps this track addresses. This section documents their approach to inform our implementation decisions.

### Architecture Comparison

| Concern | digitalme-agent | Claudy |
|---------|----------------|--------|
| Primary recording sink | `TranscriptRecorder` (JSONL per conversation) | JSONL session transcripts + OTEL spans |
| Real-time event stream | `AgentEvent` async generator (SSE) | Message stream + `HookExecutionEvent` bus |
| Telemetry backend | None (RuntimeObservers only) | OpenTelemetry (traces, metrics, logs) + Perfetto (Chrome Trace) + analytics sink |
| Span context propagation | None | `AsyncLocalStorage<SpanContext>` per interaction and tool |
| Hook event system | Callbacks on `ToolExecutor` | Dedicated `hookEvents.ts` event bus with buffering |
| Child agent tracking | Discards all events | `SubagentStart`/`SubagentStop` hooks + result schema with `totalToolUseCount`, `totalDurationMs`, `totalTokens` |
| Context pressure | `PressureBand` return value (not surfaced) | `PreCompact`/`PostCompact` hooks + `pendingPostCompaction` state flag |

### Key Design Patterns Worth Adopting

#### 1. Hook Event Bus with Buffering (hookEvents.ts)

Claudy separates hook execution events from the main message stream using a dedicated event bus:

```typescript
// Claudy pattern: register-or-buffer
const pendingEvents: HookExecutionEvent[] = []
let eventHandler: HookEventHandler | null = null

function emit(event: HookExecutionEvent): void {
  if (eventHandler) {
    eventHandler(event)
  } else {
    pendingEvents.push(event)
    if (pendingEvents.length > MAX_PENDING_EVENTS) {
      pendingEvents.shift() // drop oldest, bounded at 100
    }
  }
}
```

**Relevance to digitalme-agent:** Our `PostTurnHooks` currently swallows all errors with bare `catch {}`. Claudy's pattern of typed outcomes (`'success' | 'error' | 'cancelled'`) with buffered emission is a clean model for our Gap 2. We don't need the full event bus (we have `TranscriptRecorder`), but the **typed outcome distinction** is exactly what we need.

#### 2. Hook Execution Events — Three-Phase Lifecycle

Claudy tracks hook execution with three event types:

- `HookStartedEvent` — `{ hookId, hookName, hookEvent }` — emitted when hook begins
- `HookProgressEvent` — emitted every 1000ms with stdout/stderr diff — prevents spam by checking `output === lastEmittedOutput`
- `HookResponseEvent` — `{ exitCode, outcome: 'success' | 'error' | 'cancelled' }` — emitted on completion

**Relevance:** Our Step 4 (Post-Turn Hook Observability) should adopt the `outcome` discriminator. The progress interval pattern is overkill for our fire-and-forget hooks, but the start/end lifecycle with explicit timeout distinction maps directly to our needs.

#### 3. Subagent Result Schema with Execution Metrics

Claudy's `agentToolResultSchema()` captures rich execution metadata on subagent completion:

```typescript
// Claudy captures per-subagent:
{
  agentId: string,
  agentType: string,
  totalToolUseCount: number,
  totalDurationMs: number,
  totalTokens: number,
  // + usage breakdown: input/output/cache tokens
}
```

**Relevance:** Our `SubagentCompletedEntry` (Step 3) should include `durationMs` alongside `tokenUsage` and `toolCallCount`. Claudy proves these are the metrics that matter for debugging silent token burn.

#### 4. Explicit Hook Event Enum (26 Events)

Claudy defines a comprehensive `HOOK_EVENTS` enum covering the full agent lifecycle:

```typescript
const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'UserPromptSubmit',
  'SessionStart', 'SessionEnd',
  'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',       // ← child lifecycle
  'PreCompact', 'PostCompact',           // ← context pressure
  'PermissionRequest', 'PermissionDenied',
  'Setup', 'TeammateIdle',
  'TaskCreated', 'TaskCompleted',
  'Elicitation', 'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate', 'WorktreeRemove',
  'InstructionsLoaded', 'CwdChanged', 'FileChanged',
] as const
```

**Relevance:** This confirms that `SubagentStart`/`SubagentStop` and `PreCompact`/`PostCompact` are first-class lifecycle events in a mature agent runtime. Our transcript lifecycle types should align with this vocabulary where it makes sense.

#### 5. OpenTelemetry Span Hierarchy

Claudy structures tracing as a span tree:

```
claude_code.interaction (root — one per user request)
  ├── claude_code.llm_request (per LLM call)
  │   └── attributes: model, speed, ttft_ms, input_tokens, output_tokens, cache_*
  ├── claude_code.tool (per tool invocation)
  │   ├── tool.blocked_on_user (permission decision time)
  │   └── tool.execution (actual execution time)
  └── claude_code.hook (per hook execution)
```

Context is propagated via `AsyncLocalStorage`:
- `interactionContext: AsyncLocalStorage<SpanContext>` — scopes the interaction
- `toolContext: AsyncLocalStorage<SpanContext>` — scopes the current tool

Span cleanup uses WeakRef + 30-minute TTL interval to prevent leaks from aborted streams.

**Relevance to future work:** This is the right architecture for when we eventually add OTEL support (currently out of scope for Track 07). For now, our `TranscriptRecorder` lifecycle events serve as the structured data that a future OTEL exporter could consume. The span hierarchy is worth keeping in mind when designing our transcript entry types — they should map cleanly to spans.

#### 6. Duration Thresholds for Hook Visibility

Claudy uses two thresholds to control hook observability noise:

```typescript
HOOK_TIMING_DISPLAY_THRESHOLD_MS = 500   // show summary message to user
SLOW_PHASE_LOG_THRESHOLD_MS = 2000       // emit debug warning
```

Hooks below 500ms are silent. Between 500ms–2000ms they get a summary. Above 2000ms they trigger a debug log.

**Relevance:** Our Step 4 should adopt a similar threshold approach. Recording every hook execution to transcript is fine (low overhead), but we should only emit warnings or summaries for hooks that exceed a threshold. A single `SLOW_HOOK_THRESHOLD_MS` constant (e.g., 2000ms) would gate debug-level logging.

#### 7. Context Pressure Hooks (PreCompact/PostCompact)

Claudy fires hooks before and after context compaction:

- **PreCompact** receives `{ trigger: 'manual' | 'auto', custom_instructions }` — hooks can inject instructions to preserve through compaction
- **PostCompact** receives `{ trigger, compactSummary }` — hooks can display user-facing messages
- A `pendingPostCompaction` state flag tracks whether compaction just occurred, used by analytics

**Relevance:** Our Gap 4 (Context Pressure Visibility) is currently LOW priority. When we address it, Claudy's pattern of pre/post hooks with trigger type discrimination is the right model. For now, we should ensure our `TranscriptRecorder` lifecycle event types leave room for `compact_started` / `compact_completed` entries.

#### 8. Fork Subagent Architecture

Claudy's fork model differs from ours but the observability patterns apply:

- Fork children receive the parent's full conversation context and system prompt (byte-exact for prompt cache sharing)
- `FORK_SUBAGENT_TYPE = 'fork'` as a synthetic agent type for analytics
- Recursive fork prevention: `isInForkChild()` checks for `FORK_BOILERPLATE_TAG` in conversation history
- Fork children are mutually exclusive with coordinator mode

The key observability insight: Claudy passes `agentId` and `agentType` through SubagentStart/SubagentStop hooks, making every child agent spawn visible to external tooling. The `agent_transcript_path` field in SubagentStop allows post-hoc analysis of child execution.

**Relevance:** Our Step 2 (Forked Agent Observability) should include `forkId` in all lifecycle entries (we already plan this). We should also consider recording the transcript path for the forked agent's sidechain, matching Claudy's `agent_transcript_path` pattern.

### What Claudy Has That We Should NOT Adopt (Yet)

1. **Full OpenTelemetry stack** — Claudy runs `BasicTracerProvider`, `MeterProvider`, `LoggerProvider` with OTLP/Prometheus/Console exporters. This is significant infrastructure. Our `RuntimeObservers` + `TranscriptRecorder` are sufficient for Track 07. OTEL is a future track.

2. **Perfetto tracing** — Chrome Trace format output for flame graph debugging. Valuable for complex performance analysis but overkill for our current observability gaps.

3. **Analytics sink pattern** — `attachAnalyticsSink(sink)` with event queueing for Datadog/Statsig fanout. We don't have external analytics infra.

4. **26-event hook enum** — Most of these events (`CwdChanged`, `FileChanged`, `ConfigChange`, etc.) are specific to Claudy's interactive CLI model. Our agent is a request-response service; we need a smaller, focused set.

5. **Progress interval polling** — 1000ms polling for hook output diffs. Our hooks are fire-and-forget; we don't stream hook progress.

### Concrete Changes Informed by Claudy

Based on this analysis, the following refinements to our implementation steps:

**Step 2 (Forked Agent Observability) — add `durationMs` and `transcriptPath`:**

```typescript
interface ForkCompletedEntry extends TranscriptEntry {
  type: 'fork_completed';
  forkId: string;
  forkLabel: string;
  tokenUsage: TokenUsage;
  durationMs: number;              // ← from Claudy's agentToolResultSchema
  toolCallCount: number;           // ← from Claudy's totalToolUseCount
  transcriptPath?: string;         // ← from Claudy's agent_transcript_path
}
```

**Step 3 (Subagent Observability) — add `durationMs`:**

```typescript
interface SubagentCompletedEntry extends TranscriptEntry {
  type: 'subagent_completed';
  subagentType: string;
  tokenUsage?: TokenUsage;
  toolCallCount: number;
  completedTurns: number;
  durationMs: number;              // ← from Claudy's totalDurationMs
  model: string;                   // ← from Claudy: always capture model used
}
```

**Step 4 (Post-Turn Hook Observability) — adopt typed outcomes:**

```typescript
type HookOutcome = 'success' | 'error' | 'timeout';  // ← from Claudy's outcome discriminator

interface HookExecutedEntry extends TranscriptEntry {
  type: 'hook_executed';
  hookName: string;
  outcome: HookOutcome;
  durationMs: number;
  error?: string;                  // populated when outcome !== 'success'
}
```

With a threshold constant:

```typescript
const SLOW_HOOK_THRESHOLD_MS = 2000;  // ← aligned with Claudy's SLOW_PHASE_LOG_THRESHOLD_MS
```

**Future Step (Context Pressure) — reserve transcript types:**

When we address Gap 4, the transcript types should follow Claudy's pre/post pattern:

```typescript
interface CompactStartedEntry extends TranscriptEntry {
  type: 'compact_started';
  trigger: 'reactive' | 'proactive';  // our equivalent of Claudy's 'manual' | 'auto'
  pressureBand: PressureBand;
}
interface CompactCompletedEntry extends TranscriptEntry {
  type: 'compact_completed';
  trigger: 'reactive' | 'proactive';
  messagesRemoved: number;
  tokensSaved: number;
}
```

These are not implemented in Track 07 but are documented here so future work aligns with the established pattern.

### Summary

Claudy validates our core design decisions:
- **Extending existing recording infra** (not introducing a new event bus) is the right call — Claudy's hook event bus is separate from their main recording layer, but their transcript persistence follows the same "extend what exists" principle.
- **Typed lifecycle events** with discriminated outcomes are the right abstraction for hook observability.
- **Child agent execution metrics** (duration, tool count, tokens, model) are the minimum viable fields — Claudy ships exactly these.
- **The public protocol stays unchanged** — Claudy's OTEL and hook events are internal; their SDK message stream is analogous to our SSE protocol and is not polluted with observability data.

The main delta from Claudy's approach: they've invested heavily in OTEL for production telemetry. We defer that to a future track and rely on `TranscriptRecorder` as our single structured sink, which is simpler and sufficient for debugging.
