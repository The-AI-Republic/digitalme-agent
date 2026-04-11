# Internal Events and Observability

## Goal

Improve operational visibility without changing the external SSE protocol.

This track should make `digitalme-agent` better at:

- debugging request execution
- measuring tool/runtime behavior
- supporting future internal hook points
- tracking forked agent and subagent lifecycle
- observing post-turn hook execution
- **exporting telemetry to AI Republic backend** (instrument now, receive later)

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

8. **No telemetry export** — all observability data stays local. AI Republic has no visibility into agent behavior across deployments.

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

### Gap 5: No Telemetry Export (HIGH priority)

All observability data stays on the creator's host. AI Republic has zero visibility into:

- Agent health across deployments
- Error rates by model/creator/tool
- Token usage patterns for cost optimization
- Performance characteristics across different hosting environments

Since the agent is deployed to creator hosts and agent-side code changes require a release cycle, the instrumentation must ship with the agent from day one. The backend can be built later — AI Republic controls the receiving infrastructure and can evolve it independently.

## Target Design

### Approach: Extend Existing Infrastructure + Add OTEL Export

Two complementary strategies:

1. **TranscriptRecorder** for persisted local observability (already the primary sink)
2. **AgentEvent stream** for real-time observability (already the primary stream)
3. **Callbacks** for execution-time side effects (the ToolExecutor pattern)
4. **OpenTelemetry** for telemetry export to AI Republic backend (NEW)

### Telemetry Export Architecture

```
┌─────────────────────────┐        ┌──────────────────────────┐
│  Creator's Host          │        │  AI Republic Backend     │
│                          │        │  (built later)           │
│  digitalme-agent         │        │                          │
│  ┌─────────────────────┐ │        │  ┌────────────────────┐  │
│  │ OTEL Instrumentation│ │  OTLP  │  │ OTLP Collector     │  │
│  │ - spans             │ │───────→│  │ - receives spans   │  │
│  │ - metrics           │ │        │  │ - stores metrics   │  │
│  │                     │ │        │  │ - dashboards       │  │
│  └─────────────────────┘ │        │  └────────────────────┘  │
│  ┌─────────────────────┐ │        │                          │
│  │ TranscriptRecorder  │ │        │  Endpoint hardcoded in   │
│  │ (local JSONL)       │ │        │  agent source code.      │
│  └─────────────────────┘ │        │  Open source — creators  │
└─────────────────────────┘        │  can change if needed.   │
                                    └──────────────────────────┘
```

**Key decisions:**

- **Endpoint hardcoded** — AI Republic's OTEL collector URL is in source code. No configuration surface. Creators who want to change it can fork the code (open source).
- **Graceful degradation** — if the backend is unreachable (not built yet, network issue), telemetry is silently dropped. No impact on agent functionality.
- **No PII in telemetry** — spans and metrics contain operational data only (token counts, latency, error types, tool names). No conversation content, fan names, or creator config values.
- **Agent identity via `api_key` hash** — the agent has no explicit `creator_id` field. Identity for telemetry attribution uses `SHA-256(auth.api_key)` as a stable, non-reversible identifier. The raw key is never exported. The backend maps this hash to a creator via the platform's key registry. This avoids adding a new config field while providing reliable attribution.

### Span Hierarchy

Forks and post-turn hooks are **fire-and-forget** — they can outlive the main turn. If they were modeled as children of the interaction span, the interaction latency metric would be inflated by background work duration. Instead, background work uses **linked root spans**:

```
agent.interaction (root — one per fan message → agent response)
  ├── agent.model_call (child — each LLM API call)
  │     └── attributes: model, tokens, latency, cache stats, is_retry, is_fallback
  ├── agent.tool (child — each tool invocation)
  │     └── attributes: tool_name, duration_ms, success, error_category
  └── agent.subagent (child — synchronous subagent invocations only)
        └── attributes: subagent_type, model, duration_ms, token_usage

agent.fork (separate root, SpanLink → interaction)
  └── attributes: fork_label, duration_ms, token_usage, tool_call_count

agent.hook (separate root, SpanLink → interaction)
  └── attributes: hook_name, outcome, duration_ms
```

**Why this model:**
- `agent.interaction` span ends when the SSE response completes — gives accurate turn latency
- `agent.fork` starts as a new root span with a `SpanLink` back to the originating interaction — traceable but doesn't inflate turn metrics
- `agent.hook` same pattern — background work is linked, not nested
- `agent.model_call` and `agent.tool` are true children — they execute synchronously within the turn
- `agent.subagent` is a child when invoked synchronously via tool call; if ever invoked asynchronously, use linked root instead

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `agent.turns.total` | Counter | Total turns processed |
| `agent.turns.duration_ms` | Histogram | Turn latency distribution |
| `agent.model_calls.total` | Counter | Model API calls (by model, success/failure) |
| `agent.model_calls.tokens` | Counter | Token usage (by model, input/output) |
| `agent.tool_calls.total` | Counter | Tool invocations (by tool name) |
| `agent.tool_calls.duration_ms` | Histogram | Tool execution latency |
| `agent.forks.total` | Counter | Fork executions (by label, success/failure/rejected) |
| `agent.hooks.total` | Counter | Hook executions (by name, outcome) |
| `agent.errors.total` | Counter | Errors (by category) |
| `agent.sessions.active` | ObservableGauge | Currently active sessions (backed by `sessionManager.getStats()` callback — pull-based, not push) |

### Structured Event Logging — Owned by Track 13

Track 07 provides the OTEL instrumentation primitives (spans and metrics). **Structured event logging** (typed events, sampling, PII-safe metadata, aggregation) is owned by Track 13 (Structured Analytics). Track 13 can optionally emit events as OTEL log records using the providers initialized here, but the event schema, sampling policy, and export pipeline are Track 13's responsibility. This avoids duplicate event systems.

### Files To Change

- `src/index.ts` — initialize telemetry before listen; flush telemetry during async shutdown
- `src/agent/Agent.ts` — expose runtime owners needed for telemetry wiring if startup code needs access
- `src/agent/SessionManager.ts` — source of truth for `agent.sessions.active` observable callback
- `src/agent/fork/ForkedAgent.ts` — capture and record child events
- `src/agent/subagent/SubagentTool.ts` — capture and record child events
- `src/agent/hooks/PostTurnHooks.ts` — add observability to hook execution
- `src/agent/transcript/types.ts` — extend lifecycle event types
- `src/agent/SessionRuntime.ts` — minor: record fork/subagent lifecycle

### Files To Add

- `src/telemetry/instrumentation.ts` — OTEL provider setup, hardcoded endpoint
- `src/telemetry/spans.ts` — span creation helpers (interaction, model_call, tool, fork, subagent, hook)
- `src/telemetry/metrics.ts` — metric definitions (counters, histograms)
- `src/telemetry/attributes.ts` — attribute builders, PII-safe helpers
- `src/telemetry/types.ts` — telemetry type definitions

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
    durationMs: number;
    toolCallCount: number;
    transcriptPath?: string;
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
    durationMs: number;
    model: string;
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
- Add `HookTimeoutError` class (extends `Error`) to replace string-based timeout detection:
  ```typescript
  class HookTimeoutError extends Error {
    constructor() { super('Hook execution timed out'); }
  }
  ```
- Update `PostTurnHooks.runAll()` to throw `HookTimeoutError` instead of `new Error('hook_timeout')`
- Add optional `ITranscriptRecorder` to `PostTurnHookRegistry` constructor
- In `runAll()`, distinguish timeout from other errors using `instanceof`:
  ```typescript
  } catch (error) {
    const isTimeout = error instanceof HookTimeoutError;
    // Record hook failure with reason — no string matching
  }
  ```
- Record `hook_executed` lifecycle events with typed outcome
- Keep fire-and-forget semantics — recording failures should not crash the main agent

Typed outcome:

```typescript
type HookOutcome = 'success' | 'error' | 'timeout';

interface HookExecutedEntry extends TranscriptEntry {
  type: 'hook_executed';
  hookName: string;
  outcome: HookOutcome;
  durationMs: number;
  error?: string;
}
```

With threshold:

```typescript
const SLOW_HOOK_THRESHOLD_MS = 2000;
```

### Step 5: OTEL Instrumentation Setup

Files:
- `src/telemetry/instrumentation.ts` (NEW)
- `src/telemetry/types.ts` (NEW)
- `src/index.ts`
- `src/agent/SessionManager.ts`
- `src/agent/Agent.ts` (if needed to expose `SessionManager` to startup wiring)

Work:
- Initialize `BasicTracerProvider` with OTLP HTTP exporter
- Initialize `MeterProvider` with periodic exporter (60s interval)
- Hardcode AI Republic endpoint: `https://otel.airepublic.com/v1` (placeholder until real endpoint exists)
- Graceful degradation: if endpoint unreachable, use `NoopExporter` — zero impact on agent
- Add `AsyncLocalStorage<SpanContext>` for interaction context propagation
- Resource attributes: `service.name=digitalme-agent`, `service.version`, `agent.identity=SHA256(api_key)`, `deployment.host`
- Agent identity derived from `SHA-256(auth.api_key)` — no raw key in telemetry, no new config field needed
- Call `initTelemetry()` from agent startup (before `app.listen()`)
- Call `shutdownTelemetry()` on graceful shutdown — **requires refactoring `src/index.ts` shutdown to async**:
  ```typescript
  // Current shutdown is synchronous with process.exit() in server.close() callback.
  // Must become async to allow telemetry flush:
  const shutdown = async () => {
    if (shutting) return;
    shutting = true;
    heartbeat.stop();
    agent.beginDrain();

    // 1. Close HTTP server (stop accepting new requests)
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } catch {
      // Server close failed — continue to telemetry flush and shutdown anyway.
    }

    // 2. Flush telemetry with dedicated timeout (5s from 30s shutdown budget)
    try {
      await Promise.race([
        shutdownTelemetry(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('telemetry flush timeout')), 5_000)
        ),
      ]);
    } catch {
      // Flush failed or timed out — proceed with exit
    }

    process.exit(0);
  };
  ```
  Key constraints:
  - Server close callback follows the existing Node/Express contract used in tests: callback may receive an error. Shutdown code should handle that explicitly rather than assuming close always succeeds.
  - Telemetry flush gets **5-second timeout** carved from the existing 30-second shutdown budget
  - Flush failure must not block shutdown — silently proceed to `process.exit(0)`
  - `shutdownTelemetry()` calls `tracerProvider.shutdown()` + `meterProvider.shutdown()` (flushes pending exports)
- Add `src/telemetry/types.ts` — telemetry type definitions

### Step 6: Span Instrumentation

Files:
- `src/telemetry/spans.ts` (NEW)
- `src/agent/TurnExecutor.ts` — add span creation calls
- `src/tools/execution/ToolExecutor.ts` — add tool span
- `src/agent/fork/ForkedAgent.ts` — add fork span
- `src/agent/subagent/SubagentTool.ts` — add subagent span

Work:
- Implement span helpers:
  ```typescript
  // Child spans (synchronous within the turn)
  startInteractionSpan(conversationId: string): Span
  startModelCallSpan(model: string, parent: Span): Span
  startToolSpan(toolName: string, parent: Span): Span
  startSubagentSpan(subagentType: string, model: string, parent: Span): Span

  // Linked root spans (background work that outlives the turn)
  // Pass a captured SpanContext or prebuilt Link, not a Span instance.
  startForkSpan(forkLabel: string, interactionContext: SpanContext): Span
  startHookSpan(hookName: string, interactionContext: SpanContext): Span

  endSpan(span: Span, attributes?: Record<string, AttributeValue>): void
  ```
- Capture `interactionSpan.spanContext()` while the interaction span is alive and thread that immutable context into fork/hook launch paths.
- Do **not** retain or pass ended `Span` objects into background work. `SpanLink` should be built from the captured `SpanContext` when the linked root span starts.
- Fork and hook spans are **separate root spans** with a `SpanLink` back to the originating interaction — they outlive the turn and must not inflate turn latency metrics
- Model call and tool spans are **true children** — they execute synchronously within the turn
- Wire into existing execution paths — span creation at start, end with attributes at completion
- Model call span: record `input_tokens`, `output_tokens`, `cache_read_tokens`, `latency_ms`, `is_retry`, `is_fallback`
- Tool span: record `tool_name`, `duration_ms`, `success`, `error_category`
- Fork span (linked root): record `duration_ms`, `token_usage`, `tool_call_count`
- Subagent span (child): record `subagent_type`, `model`, `duration_ms`, `token_usage`, `tool_call_count`
- Hook span (linked root): record `hook_name`, `outcome`, `duration_ms`

### Step 7: Metrics Instrumentation

Files:
- `src/telemetry/metrics.ts` (NEW)
- Wire into `TurnExecutor`, `ToolExecutor`, `ForkedAgent`, `PostTurnHooks`, and `SessionManager`

Work:
- Define metrics:
  ```typescript
  const turnCounter = meter.createCounter('agent.turns.total');
  const turnDuration = meter.createHistogram('agent.turns.duration_ms');
  const modelCallCounter = meter.createCounter('agent.model_calls.total');
  const tokenCounter = meter.createCounter('agent.model_calls.tokens');
  const toolCallCounter = meter.createCounter('agent.tool_calls.total');
  const toolDuration = meter.createHistogram('agent.tool_calls.duration_ms');
  const forkCounter = meter.createCounter('agent.forks.total');
  const hookCounter = meter.createCounter('agent.hooks.total');
  const errorCounter = meter.createCounter('agent.errors.total');
  const activeSessions = meter.createObservableGauge('agent.sessions.active', {
    description: 'Currently active sessions',
  });
  ```
- Increment counters at existing instrumentation points (same places spans are created)
- Register `agent.sessions.active` as a **pull-based observable callback** that reads `sessionManager.getStats().activeSessions` at collection time.
- The callback owner must have access to the live `SessionManager` instance. Day-one wiring should happen at startup (`src/index.ts`) after constructing `Agent`, either by:
  1. exposing `agent.getSessionManager()` explicitly, or
  2. having `Agent` register the callback internally during telemetry initialization.
- Do **not** model active sessions as a push-updated counter; Track 06 intentionally keeps session counts as on-demand state rather than reactive store fields.
- Label with relevant attributes: `model`, `tool_name`, `fork_label`, `hook_name`, `success`, `error_category`
- No PII in any metric label

### Step 8: PII-Safe Attribute Helpers

Files:
- `src/telemetry/attributes.ts` (NEW)

Work:
- PII-safe attribute builders used by spans and metrics:
  ```typescript
  function safeAttributes(raw: Record<string, unknown>): Record<string, AttributeValue>
  ```
- Strip conversation content, fan names, creator config values
- Allow only: token counts, latencies, error codes, model names, tool names, enum values
- Used by span and metric instrumentation in Steps 6-7

**Note:** Structured event logging (typed events, sampling, export pipeline) is owned by Track 13 (Structured Analytics). Track 13 can use the OTEL providers initialized in Step 5 to emit events as OTEL log records. This avoids duplicate event schemas and sampling policies between tracks.

### Step 9: Context Pressure Events

Files:
- `src/agent/transcript/types.ts`
- `src/agent/context/prepareContextForModelCall.ts`

Work:
- Add transcript types:
  ```typescript
  interface CompactStartedEntry extends TranscriptEntry {
    type: 'compact_started';
    trigger: 'reactive' | 'proactive';
    pressureBand: PressureBand;
  }
  interface CompactCompletedEntry extends TranscriptEntry {
    type: 'compact_completed';
    trigger: 'reactive' | 'proactive';
    messagesRemoved: number;
    tokensSaved: number;
  }
  ```
- Record when microcompact, projection, or reactive compact runs
- If `prepareContextForModelCall()` does not already return `messagesRemoved` / `tokensSaved` for all compaction paths, extend its return contract in this track so callers do not infer those values indirectly.
- Prefer computing these values inside `src/agent/context/prepareContextForModelCall.ts`, where the before/after message sets and token accounting are already available, rather than reconstructing them later in `TurnExecutor`.
- Also emit as OTEL span events on the parent interaction span

### Step 10: Clean Up and Verify

Work:
- Ensure `TranscriptEntry.type` union is exhaustive and all new types are covered
- Verify transcript files contain fork/subagent/hook events in integration tests
- Verify the public `AgentEvent` stream is unchanged
- Verify telemetry export works when endpoint is reachable
- Verify telemetry degrades gracefully when endpoint is unreachable
- Verify no PII leaks in any exported span, metric, or event

## What This Track Does NOT Do

- **No Perfetto/Chrome Trace** — local debugging tool, not relevant to client-server telemetry
- **No configurable telemetry endpoint** — hardcoded to AI Republic. Open source, change in code if needed.
- **No progress interval polling** — our hooks are fire-and-forget, not long-running
- **No change to the public SSE protocol** — all new events are internal (transcript + OTEL only)

## Dependency on Other Tracks

- **Track 06 (Runtime State and Observers)**: Implemented. `RuntimeStore`, `ProcessRuntimeState`, `RuntimeObservers`, `TurnExecutionState` are all in place.
- **Track 05 (Transcript and Artifact Storage)**: `TranscriptRecorder` is implemented and is the primary extension point for this track.
- **Track 04 (Recovery and Continuation)**: Implemented. Recovery events already flow through `AgentEvent.recovery`.
- **Track 03 (Tool Runtime)**: Implemented. `ToolExecutor` with callbacks and `ToolExecutionRecord` provides tool-level observability.
- **Track 11 (Usage Tracking)**: OTEL metrics feed into usage tracking — token counters and cost metrics overlap. Coordinate to avoid double-counting.
- **Track 13 (Structured Analytics)**: Track 07 owns OTEL primitives (spans + metrics). Track 13 owns structured event logging (typed events, sampling, aggregation, health endpoint). Track 13 should consume the OTEL providers initialized here to emit events as log records — not build a parallel export pipeline.

## Testing Strategy

Add tests for:

- `fork_started` / `fork_completed` / `fork_failed` / `fork_rejected` appear in transcript for forked agent runs
- `subagent_started` / `subagent_completed` / `subagent_failed` appear in transcript for subagent runs
- hook timeout produces a distinct event from hook failure
- fork rejection records the correct reason (`semaphore_full` vs `forks_disabled`)
- subagent event includes `subagentType`, model, and tool count
- no new events appear in the public `AgentEvent` stream (SSE contract unchanged)
- if sidechain recording is implemented: forked/subagent messages appear with `isSidechain: true`
- OTEL spans are created with correct relationships (children for sync work, linked roots for background work)
- OTEL metrics increment correctly
- telemetry gracefully degrades when endpoint is unreachable (no errors, no impact)
- no PII appears in any exported telemetry data

## Risks

- **Threading `ITranscriptRecorder` through too many modules** — forked agent and subagent modules currently have no recorder dependency. Adding it increases coupling. Mitigated by passing it as an optional field in existing params/deps interfaces.
- **Sidechain recording volume** — recording full message chains for every fork and subagent could produce large transcript files. Mitigated by making sidechain recording opt-in via `ForkedAgentConfig.skipTranscript` (already exists) and a similar flag for subagents.
- **Hook recording failures** — if `TranscriptRecorder` itself fails during hook error recording, the double-failure should not propagate. Wrap in try-catch.
- **OTEL dependency weight** — `@opentelemetry/*` packages add to bundle size. Mitigated by lazy-loading OTEL modules and keeping the core agent independent (OTEL is additive, not required).
- **Telemetry endpoint availability** — if AI Republic backend is down, agent must not be affected. Mitigated by `NoopExporter` fallback and fire-and-forget semantics.
- **PII leakage** — conversation content, fan names, or creator config could accidentally end up in telemetry. Mitigated by explicit PII-safe attribute builders and code review policy.

## Success Criteria

- Forked agent execution is visible in transcript logs without code changes
- Subagent execution is visible in transcript logs without code changes
- Post-turn hook failures and timeouts are distinguishable in transcript logs
- `RolloutRecorder` is removed from the codebase
- The public SSE protocol (`AgentEvent`) is unchanged
- No new event bus or pub/sub infrastructure is introduced
- OTEL spans and metrics are exported to AI Republic endpoint (structured events are Track 13's responsibility)
- Telemetry degrades gracefully when backend is unreachable
- Zero PII in exported telemetry
- Agent startup/shutdown handles telemetry lifecycle cleanly

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
| Telemetry backend | **OTEL export to AI Republic (NEW)** | OpenTelemetry (traces, metrics, logs) + Perfetto (Chrome Trace) + analytics sink |
| Span context propagation | **AsyncLocalStorage (NEW)** | `AsyncLocalStorage<SpanContext>` per interaction and tool |
| Hook event system | Callbacks on `ToolExecutor` | Dedicated `hookEvents.ts` event bus with buffering |
| Child agent tracking | **Lifecycle entries + OTEL spans (NEW)** | `SubagentStart`/`SubagentStop` hooks + result schema with `totalToolUseCount`, `totalDurationMs`, `totalTokens` |
| Context pressure | `PressureBand` return value → **transcript entries (NEW)** | `PreCompact`/`PostCompact` hooks + `pendingPostCompaction` state flag |

### Key Design Patterns Adopted

#### 1. Typed Outcomes for Hook Execution

From Claudy's `HookResponseEvent` — three-phase lifecycle with `outcome: 'success' | 'error' | 'cancelled'`. We adopt as `HookOutcome = 'success' | 'error' | 'timeout'`.

#### 2. Subagent Result Schema with Execution Metrics

From Claudy's `agentToolResultSchema()` — `totalToolUseCount`, `totalDurationMs`, `totalTokens`. We adopt all three in `SubagentCompletedEntry` and `ForkCompletedEntry`.

#### 3. Duration Thresholds for Hook Visibility

From Claudy's `SLOW_PHASE_LOG_THRESHOLD_MS = 2000`. We adopt as `SLOW_HOOK_THRESHOLD_MS = 2000`.

#### 4. OTEL Span Hierarchy (adapted)

From Claudy's `interaction → llm_request → tool → hook` hierarchy. We adopt `agent.*` prefixed span names but **diverge on background work**: Claudy's interactive CLI model can afford to keep interaction spans open longer; our request/response model uses linked root spans for fire-and-forget forks and hooks to preserve accurate turn latency metrics.

#### 5. AsyncLocalStorage for Context Propagation

From Claudy's `interactionContext` and `toolContext` AsyncLocalStorage. We adopt `interactionContext` for propagating the root span across async boundaries.

#### 6. Graceful Telemetry Degradation

From Claudy's behavior when OTEL exporters fail — silently drops data, no agent impact. We adopt the same with `NoopExporter` fallback.

### What We Did NOT Adopt

1. **Perfetto tracing** — local debugging tool, not relevant to client-server architecture
2. **26-event hook enum** — most events are CLI-specific; server agent needs ~10 events
3. **Progress interval polling** — our hooks are fire-and-forget
4. **Analytics sink fan-out** — Claudy fans out to Datadog + 1P logger; we export via OTEL only
5. **Beta tracing with content** — Claudy has a beta mode that includes system prompts and model output in traces; we explicitly exclude all content for PII safety
