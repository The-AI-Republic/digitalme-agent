# Runtime State and Observers

## Goal

Make runtime state more explicit and side effects more controlled without recreating a giant product-runtime state container.

This track should make `digitalme-agent` better at:

- describing current process health clearly
- separating process state from conversation state from request state
- centralizing operational side effects

## Current State

Today runtime state is distributed across:

- `src/agent/Agent.ts`
- `src/agent/SessionManager.ts`
- `src/agent/SessionRuntime.ts`
- `src/agent/SessionState.ts`
- local variables inside `src/agent/TurnExecutor.ts`

That is workable today, but side effects and runtime facts will become harder to reason about as the system grows.

### Current Side Effects Audit

Before building new structure, this is the inventory of what exists today.

#### Process-Level State (scattered across classes)

- `Agent.activeRequests` (Set) — active request IDs
- `Agent.completedRequests` / `Agent.failedRequests` — cumulative counters
- `Agent.draining`, `SessionManager.draining`, `SubmissionQueue.draining`, `ShutdownController.draining` — draining flag duplicated four times
- `SubmissionQueue.activeConversations` (Set) — conversations with active work
- `SubmissionQueue.activeCount` — current concurrency slot usage
- `SubmissionQueue.pendingByConversation` (Map) — per-conversation queue depth
- `SessionManager.sessions` (Map) — active session count

#### Conversation-Level State

- `SessionRuntime.activeTurn` — current turn execution handle
- `SessionRuntime.activeForkedAgents` (Map) — background fork tasks
- `SessionState` — canonical history, prompt history, turn IDs, revision, timestamps
- `ForkSemaphore.running` — per-session fork concurrency

#### Request-Scoped State (local variables and short-lived objects)

- `TurnContext.turnCount` — loop iteration counter
- `TurnContext.messages` — accumulated prompt messages
- `TurnContext.tokenUsage` — token consumption
- `TurnState.modelTurnCount` / `TurnState.toolCallCount` — model and tool invocation counters
- `TurnState.pendingToolCallIds` — in-flight tool tracking
- `ActiveTurn.status`, `ActiveTurn.errorMessage`, `ActiveTurn.startedAt` / `ActiveTurn.completedAt` — turn lifecycle

#### Scattered Side Effects

- `RolloutRecorder.record()` — writes JSONL to disk (called from SessionRuntime for task_started, task_completed, task_failed, session_reseeded)
- `SessionManager.evictExpiredSessions()` — TTL-based cleanup
- `SessionManager.evictToCapacity()` — LRU eviction at capacity
- `PostTurnHookRegistry.runAll()` — fire-and-forget post-turn hooks (errors swallowed)
- `SubmissionQueue.startNext()` — dequeues and launches next submission
- `Agent.getHealth()` — aggregates health from multiple sources on demand

#### Known Fragmentation Issues

- Draining flag exists in four places with no single source of truth
- TTL tracking split between `SessionState.lastAccessedAt` (updated via touch()) and eviction logic in `SessionManager`
- Health data pulled on demand from multiple sources — no snapshot
- Rollout recording called inline from SessionRuntime (this is correct placement — per-turn context is needed; see Observer Model section for why this stays)

## Claudy Patterns Worth Borrowing

Relevant source references:

- `/home/rich/dev/study/claudy/src/state/AppStateStore.ts`
- `/home/rich/dev/study/claudy/src/state/onChangeAppState.ts`
- `/home/rich/dev/study/claudy/src/state/store.ts`
- `/home/rich/dev/study/claudy/src/bootstrap/state.ts`

The most important transferable pattern is not “have a giant app state.”

The most important pattern is:

- one store-like mutation path
- one `onChange`-style choke point reacting to state diffs
- side effects not scattered throughout request execution

### Store Primitive

Claudy's store is ~20 lines: `createStore(initialState, onChange)` returning `{ getState, setState, subscribe }`.

- `setState` takes an updater function `(prev: T) => T`
- `Object.is(next, prev)` short-circuits no-op mutations — no onChange, no listeners
- `onChange({ oldState, newState })` fires after assignment but before listener notification

digitalme-agent does not need `subscribe` (no React). The store is just a typed wrapper ensuring all mutations go through one path and fire one callback.

### onChange Shape

Claudy's `onChangeAppState` is a single concrete function (~120 lines) with explicit if-checks per field:

```
if toolPermissionContext.mode changed → notify CCR, notify SDK status
if mainLoopModel changed → persist to settings file
if settings changed → clear auth caches, re-apply env vars
```

No observer registry, no event names, no pub/sub. Just plain field-diff comparisons.

### What Stays Outside the Store

Claudy keeps a separate non-reactive `bootstrap/state.ts` (plain global singleton) for:

- cumulative counters (totalCostUSD, totalAPIDuration)
- session identity (sessionId, originalCwd)
- caches (systemPromptSectionCache)
- static config set at startup (isInteractive, clientType)

Principle: if nothing needs to react when it changes, it does not belong in the reactive store.

### Listener Indirection

Side effects in `onChangeAppState` do not directly import CCR or metrics code. They call through a thin listener registration layer (`sessionState.ts`):

```
onChange detects diff → notifySessionMetadataChanged(metadata)
                        → registered listener?.()  (wired at startup)
```

This keeps the store layer testable without standing up real external dependencies.

### Claudy's Store Scope and Access Pattern

Claudy runs **one conversation per process**. The AppState store is process-scoped, and since process = session, there is no multi-session isolation concern. One store holds everything: permission mode, model config, MCP connections, plugins, tasks, UI state (~80+ fields in a single flat `DeepImmutable` object). This is the only reactive store in the codebase (two creation sites — one for interactive/React mode, one for headless/SDK mode — but same type, same `onChangeAppState` callback).

The store is **not a global**. It is threaded through the system as explicit function parameters:

```
createStore(initialState, onChangeAppState)
    ↓
store.getState → passed as getAppState
store.setState → passed as setAppState
    ↓
QueryEngineConfig { getAppState, setAppState }
    ↓
ToolUseContext { getAppState, setAppState }  ← every tool receives this
```

In interactive (React) mode, the store is held in React context (`AppStoreContext`) and accessed via hooks (`useAppState`, `useSetAppState`). In headless/SDK mode, it is a local variable in the bootstrap function, and `getState`/`setState` are passed as closures to `runHeadless()`. Both paths converge: `getAppState`/`setAppState` land on `ToolUseContext` and get threaded through every tool call, permission check, and subagent.

### How Claudy's Core Agent Logic Uses the Store

The store is not just a React concern. The core (non-UI) agent logic is the heaviest consumer:

- **Permission system** (`permissions.ts`): reads `getAppState()` for `toolPermissionContext.mode` before every tool execution; writes `setAppState()` to persist allow/deny rules after user decisions; tracks denial counters for fallback behavior.
- **QueryEngine** (`QueryEngine.ts`, the main agent loop): reads `getAppState()` at turn start for current permission mode and model; calls `setAppState()` to update permission rules after processing user input; wraps `setAppState` into scoped updaters (e.g. `updateFileHistoryState`) so subsystems don't need to know the full state shape.
- **Tool execution** (`toolExecution.ts`): reads `getAppState()` for permission mode and speculative classifier checks; writes `setAppState()` to update MCP client status on auth errors.

### Subagent Isolation via Store Access Control

When a subagent spawns, `createSubagentContext()` controls store access:

- **Async agents** get `setAppState: () => {}` (a no-op) — they cannot mutate the parent's state. They still get a working `getAppState`, wrapped to set `shouldAvoidPermissionPrompts: true` so they auto-deny instead of prompting.
- **Sync agents** get `shareSetAppState: true` — they share the real `setAppState`.
- **All agents** get `setAppStateForTasks` — a backdoor to the real store specifically for registering/killing background tasks, even when `setAppState` is a no-op (prevents zombie processes).

### Why digitalme-agent Needs a Narrower Scope

Claudy's "one store holds everything" works because one process = one session. digitalme-agent is a **multi-tenant server** handling many concurrent conversations per process. Putting conversation-level state in a single process store would conflate sessions.

This is why the target design splits state by lifecycle:

- **ProcessRuntimeState** (in the store, shared across all conversations) — draining and active request count. This is the direct analog to Claudy's AppState, but scoped to the only process-level facts that currently need reactive side effects.
- **SessionState** (per-conversation, stays as-is) — history, prompt history, summary. Each conversation has its own instance. No store needed.
- **TurnExecutionState** (per-request, short-lived) — iteration count, tool calls, token usage. Created and destroyed per turn. No store needed.

The store primitive and onChange pattern transfer directly. The state shape does not.

## Target Design for DigitalMe Agent

### New Modules

- `src/agent/RuntimeStore.ts`
  - the store primitive: `createStore(initialState, onChange)` with `getState` / `setState`
  - `Object.is` short-circuit on identity-equal state
- `src/agent/ProcessRuntimeState.ts`
  - active request count, draining
- `src/agent/TurnExecutionState.ts`
  - request-scoped runtime execution state
- `src/agent/RuntimeObservers.ts`
  - single `onRuntimeStateChange(oldState, newState)` function with explicit field-diff checks

### Existing Files To Change

- `src/agent/Agent.ts`
- `src/agent/SubmissionQueue.ts`
- `src/agent/SessionManager.ts`
- `src/agent/SessionRuntime.ts`
- `src/agent/TurnExecutor.ts`
- `src/agent/TurnContext.ts`
- `src/agent/TurnState.ts` (deleted — replaced by TurnExecutionState)
- `src/agent/ActiveTurn.ts`
- `src/agent/shutdown.ts` (deleted — ShutdownController replaced by store's draining field)

## Suggested State Split

### Process Runtime State (in the store, observable)

Belongs in `ProcessRuntimeState.ts`:

```typescript
interface ProcessRuntimeState {
  activeRequestCount: number;  // derived from Agent.activeRequests.size
  draining: boolean;           // single source of truth — replaces four duplicated flags
}
```

Only two fields. Both have clear reactive value: the observer can emit metrics when requests start/complete and when draining begins.

**What is NOT in the store:** Queue stats (`activeConversationCount`, `queuePressure`) and session stats (`activeSessions`, `activeTurns`) are read on demand by the health endpoint via `queue.getStats()` and `sessionManager.getStats()`. They do not need to be reactive — no observer needs to react to "a conversation was added to the queue." Putting them in the store would require a callback mechanism to synchronize SubmissionQueue mutations with store writes, which adds significant complexity (ordering, rollback, multi-setState coordination) for no current consumer. If reactive queue metrics are needed in the future, `activeConversationCount` and `queuePressure` can be added to the type and a callback mechanism introduced at that time.

`providerHealth` is also excluded — the current codebase has no runtime provider health tracking.

Note: `Agent.activeRequests` is currently a `Set<string>` used for duplicate request rejection (`Agent.ts:37` checks `has(requestId)` and throws 409). A count alone would lose this behavior. The Set stays as **non-reactive per-instance state on Agent** (like the completed/failed counters). The store holds the derived `activeRequestCount` for health and metrics.

### Process Accumulator State (non-reactive per-instance state, not observable)

Does not belong in the reactive store:

- active request IDs (`Agent.activeRequests` Set) — needed for duplicate request rejection, not just counting
- cumulative completed/failed request counters (`Agent.completedRequests`, `Agent.failedRequests`)
- timing accumulators (total API duration, total tool duration)
- session identity (agentId, startup timestamp)
- caches

These are read on demand (e.g. health endpoint) or used for correctness checks (dedup), never observed. They must remain **per-instance fields** on Agent (or whatever class owns the store), not module-level globals. Agent is instantiable and tests create multiple Agent instances — module state would bleed counters across instances.

### Conversation Runtime State

Mostly remains in `SessionState.ts`, but should be made more explicit:

- canonical history
- prompt history
- summary memory
- recent tool outcomes
- last projection metadata

### Turn Execution State

`TurnExecutionState` **replaces** the existing `TurnState` class (`src/agent/TurnState.ts`) and absorbs the execution-tracking fields from `TurnContext`. It does not wrap or extend `TurnState` — `TurnState.ts` is deleted.

`TurnContext` **survives as a reduced object**. It keeps the request identity and message accumulation that `TurnExecutor` needs for the ReAct loop:

- `requestId`, `conversationId`, `userMessage`, `history`, `signal` — request identity (stays)
- `messages: Message[]` — accumulated prompt messages (stays)

The fields that move to `TurnExecutionState`: `turnCount` and `tokenUsage`. After the change, TurnContext is a thin request-scoped container for identity + messages. TurnExecutionState is the execution tracker.

`ActiveTurn` (`src/agent/ActiveTurn.ts`) keeps its lifecycle role (status, startedAt, completedAt, fail/complete methods) but holds a `TurnExecutionState` instead of a `TurnState`:

```
ActiveTurn
├── status, startedAt, completedAt, errorMessage  (lifecycle — stays)
└── executionState: TurnExecutionState             (replaces turnState: TurnState)
```

Fields in `TurnExecutionState`:

- iteration index (from `TurnContext.turnCount`)
- model turn count (from `TurnState.modelTurnCount`)
- tool call count (from `TurnState.toolCallCount`)
- pending tool call IDs (from `TurnState.pendingToolCallIds`)
- token usage (from `TurnContext.tokenUsage`)

Possible future fields, but **not part of this track unless their producers already exist**:

- estimated prompt size
- continuation reason
- terminal reason

Those require concrete producer APIs before they are useful. Today `prepareContextForModelCall()` returns `pressure`, but not estimated token count; `TurnExecutor` also has no continuation/terminal-reason enum beyond returning final text or throwing errors. Do not add inert fields to `TurnExecutionState` in this track. If a future context-management track exposes `estimatedTokens` or explicit terminal reasons, add them then with update points and tests.

#### Creation and ownership

There are two paths:

1. **Main turn path** (via `SessionRuntime`): `ActiveTurn` creates `TurnExecutionState` in its constructor — the same pattern as today where `ActiveTurn` creates `TurnState` at `ActiveTurn.ts:8`. `SessionRuntime` creates `ActiveTurn` at `SessionRuntime.ts:110` and passes it to `TurnExecutor`. `TurnExecutor` accesses execution state via `activeTurn.executionState`.

2. **Without ActiveTurn** (forked agents, subagents, tests): `activeTurn` is optional (`activeTurn?: ActiveTurn` at `TurnExecutor.ts:74`). Today, `TurnContext` tracks `turnCount` and `tokenUsage` regardless of whether `activeTurn` is present, so these callers still work. Since TurnExecutionState absorbs those fields from TurnContext, `TurnExecutor.run()` must create a **local fallback `TurnExecutionState`** when `activeTurn` is absent:

```typescript
const executionState = activeTurn?.executionState ?? new TurnExecutionState();
```

This local instance is used for the duration of the run and discarded at the end — same lifecycle as the TurnContext fields it replaces. Call sites that pass no `activeTurn` (`ForkedAgent.ts:51`, `SubagentTool.ts:124`, tests) require no changes.

#### Lifecycle

- Created by `ActiveTurn`'s constructor (which is called by `SessionRuntime` at turn start)
- Accessed by `TurnExecutor` via the `activeTurn` parameter throughout the ReAct loop
- Disposed at turn end (completion or failure) when `SessionRuntime` clears `this.activeTurn`
- Not observable via the store — the agent has no UI that needs to react to per-turn progress

This is a short-lived request-scoped object, not part of the reactive store. The store only needs to know about the process-level facts that currently have reactive value, not conversation-level state or per-iteration execution details.

## Observer Model

`RuntimeObservers.ts` should export a single concrete function:

```typescript
function onRuntimeStateChange(oldState: ProcessRuntimeState, newState: ProcessRuntimeState): void
```

It should contain explicit field-diff checks, not an abstract observer registry:

```
if activeRequestCount changed → notify active request count listener
if draining changed → emit drain-started metric
```

Side effects should call through registered listeners (set once at startup), not directly import metrics or health implementations. This keeps the observer testable.

It should not become a broad event bus for arbitrary features.

There is no separate health snapshot in the day-one design. `Agent.getHealth()` remains the health source of truth and aggregates current values on demand from the store, Agent counters, `SubmissionQueue.getStats()`, and `SessionManager.getStats()`. If a future heartbeat or metrics path needs a cached snapshot, define a concrete snapshot owner at that point.

### What Belongs in the Observer vs. What Does Not

The observer handles **observational side effects** — passive reactions that do not affect correctness:

- Active request count metrics or diagnostics (activeRequestCount changed)
- Drain-started / drain-completed metrics (draining changed)

The observer **must not** handle **lifecycle control flow** — actions where ordering, error handling, or correctness depend on synchronous execution:

- `SubmissionQueue.startNext()` — dequeuing and launching the next turn is queue correctness logic. It runs synchronously in the `finally` block of the completing turn. Routing it through an observer would break FIFO ordering guarantees and introduce race conditions.
- `beginDrain()` cascade — Agent sets draining in the store, then calls `sessionManager.beginDrain()` to abort forks. SubmissionQueue needs no explicit drain call — it reads `store.getState().draining` on the next `submit()` and rejects. This must remain an explicit command path. The observer only sees the state diff; it does not drive the cleanup.
- Session eviction (`evictExpiredSessions`, `evictToCapacity`) — these are lifecycle operations that must run in a controlled context, not as reactions to state diffs.
- Fork abort (`SessionRuntime.abortForkedAgents`) — must be called explicitly during drain, not triggered by observing a state change.

### Integration with Track 05 (Transcript and Artifact Storage)

Rollout recording (`RolloutRecorder.record()`) is **not** a candidate for `onRuntimeStateChange`. The observer receives `ProcessRuntimeState` diffs (active request count, draining), but rollout events need per-turn, per-conversation payloads:

- `task_started` needs conversationId, taskId, turnId, session snapshot, platformHistoryCount
- `task_completed` needs finalText, completedTurns, toolCallCount, tokenUsage, session snapshot
- `task_failed` needs error message, turn snapshot

Process-state diffs are the wrong signal for these. Rollout recording should remain as direct calls from `SessionRuntime`, where the per-turn context is available. When track 05 lands, it should introduce its own recording hook registered on `SessionRuntime` (similar to how `PostTurnHookRegistry` works today), not route through the process-level observer.

## Store Ownership

### Who creates and owns the store

`Agent` creates the store in its constructor and holds it as a private field.

```
Agent (owns store + non-reactive instance state)
├── store: Store<ProcessRuntimeState>          (private, created in constructor)
├── activeRequests: Set<string>                (non-reactive, for duplicate rejection)
├── completedRequests / failedRequests         (non-reactive counters)
├── SubmissionQueue (constructed with store.getState for draining check)
└── SessionManager (constructed with store.getState for draining check)
```

### Who writes to the store

Only `Agent` calls `store.setState()`. Three write points:

1. **`Agent.submit()` — after `queue.submit()` succeeds:**

```typescript
submit(submission) {
  if (this.store.getState().draining) throw new AgentRequestError('shutting_down', 503);
  if (this.activeRequests.has(submission.requestId)) throw new AgentRequestError('request_in_progress', 409);

  this.activeRequests.add(submission.requestId);
  try {
    const events = this.queue.submit(submission, async (events) => { ... }, (failed) => {
      this.activeRequests.delete(submission.requestId);
      this.store.setState(prev => ({ ...prev, activeRequestCount: prev.activeRequestCount - 1 }));
      if (failed) this.failedRequests++; else this.completedRequests++;
    });
    this.store.setState(prev => ({ ...prev, activeRequestCount: prev.activeRequestCount + 1 }));
    return events;
  } catch (e) {
    this.activeRequests.delete(submission.requestId);  // rollback dedup only; store was never incremented
    throw e;
  }
}
```

The store increment happens **after** `queue.submit()` succeeds. If `queue.submit()` throws (`queue_full`), only the dedup Set needs rollback — the store was never touched. No store rollback needed.

2. **`onComplete` callback — decrements activeRequestCount** when a request finishes (shown in the code above).

3. **`Agent.beginDrain()` — sets draining to true,** then calls `sessionManager.beginDrain()` to abort forks. SubmissionQueue needs no explicit drain call — it reads `store.getState().draining` on the next `submit()` and rejects.

### Who reads from the store

- **`Agent.getHealth()`** — reads `store.getState()` for `draining` and `activeRequestCount`, plus on-demand reads from non-reactive state: `activeRequests.size`, `completedRequests`, `failedRequests` from Agent instance fields, `queue.getStats()` for queue details (activeConversations, pendingCount), and `sessionManager.getStats()` for session/turn counts.
- **`RuntimeObservers.onRuntimeStateChange()`** — receives old/new state diffs for observational side effects.
- **SubmissionQueue and SessionManager** — receive `store.getState` as a constructor dependency for read-only access (checking `draining` to reject new work).

### Impact on AgentDeps and testing

`Agent`'s constructor currently accepts `AgentDeps`:

```typescript
interface AgentDeps {
  queue?: SubmissionQueue; // replace with queueFactory in this track
  sessionManager?: Pick<SessionManager, 'execute' | 'getStats' | 'beginDrain'>;
}
```

Changes:

- Replace `queue?: SubmissionQueue` with a factory or test-only override that can receive `getState`, e.g. `queueFactory?: (getState: () => ProcessRuntimeState) => SubmissionQueue`. A prebuilt queue cannot be wired to the store created inside `Agent`.
- Keep `sessionManager?: Pick<SessionManager, 'execute' | 'getStats' | 'beginDrain'>` as a test override only. Mock session managers in tests do not need to read the store because `Agent.submit()` already rejects new external submissions before calling them. Production `SessionManager` is constructed by `Agent` with `getState`.
- Production `SessionManager` gains a new constructor dependency: `getState: () => ProcessRuntimeState` for reading the draining flag in `execute()`. `beginDrain()` is kept but simplified — it no longer sets a local flag, it only aborts forked agents.
- Production `SubmissionQueue` gains a new constructor dependency: `getState: () => ProcessRuntimeState` for reading the draining flag in `submit()`. No other changes — SubmissionQueue keeps its internal admission control state and FIFO logic untouched.
- Integration tests that create `new Agent(config, { sessionManager: ... })` continue to work because Agent creates the store internally and performs the external drain check before calling the mocked session manager. The mocked sessionManager keeps `beginDrain` in its shape but simplifies to just aborting forks (no local flag).
- If tests need to verify store state, they can call `agent.getHealth()` which reads from the store.

### Why not a RuntimeController

A separate RuntimeController class would add indirection without clear benefit at this stage. Agent is small (~76 lines) and already plays the coordinator role. If Agent grows significantly (provider failover, rate limit backoff, memory pressure signals), extracting a RuntimeController is a mechanical refactor — move `setState` calls and accumulators into a new class, give Agent a reference to it. The current design does not preclude this.

## Suggested Implementation Sequence

### Step 0: Audit and Map

Files:

- all files listed in the Current Side Effects Audit above

Work:

- verify the audit above is still accurate at implementation time
- map each scattered side effect to its target location in the new design
- identify any side effects missed by this audit

### Step 1: RuntimeStore

Files:

- new `src/agent/RuntimeStore.ts`

Work:

- implement `createStore(initialState, onChange)` with `getState`, `setState`, `Object.is` short-circuit
- this is ~20 lines — keep it minimal

### Step 2: ProcessRuntimeState

Files:

- new `src/agent/ProcessRuntimeState.ts`
- update `src/agent/Agent.ts`
- update `src/agent/SubmissionQueue.ts`
- update `src/agent/SessionManager.ts`
- delete `src/agent/shutdown.ts` (ShutdownController replaced by store's draining field)

Work:

- define the `ProcessRuntimeState` type (two fields: `activeRequestCount`, `draining`)
- Agent creates the store in its constructor and holds it as a private field
- Agent is the only writer to the store (three write points: submit success, onComplete, beginDrain — see Store Ownership for the exact code)
- unify the four duplicated draining flags into one store field:
  - delete `ShutdownController` (`shutdown.ts`) entirely
  - remove `SubmissionQueue.draining` field and `SubmissionQueue.beginDrain()` / `isDraining()` methods — SubmissionQueue reads `store.getState().draining` in its `submit()` method to reject new work
  - remove `SessionManager.draining` field — SessionManager reads `store.getState().draining` in its `execute()` method to reject new work
  - keep `SessionManager.beginDrain()` as a public lifecycle method, but it no longer sets a local flag — it only calls `abortForkedAgents()` on all sessions
  - `Agent.beginDrain()` sets `draining: true` in the store, then calls `sessionManager.beginDrain()` to abort forks
- SubmissionQueue and SessionManager receive `store.getState` as a constructor dependency for read-only access (check draining to reject work)
- SubmissionQueue keeps all its internal state (activeConversations, pendingByConversation, activeCount) and FIFO logic untouched
- keep cumulative counters (completed/failed) and activeRequests Set as non-reactive per-instance fields on Agent
- health endpoint reads `store.getState()` for `draining` and `activeRequestCount`, plus on-demand reads from Agent instance fields, `queue.getStats()`, and `sessionManager.getStats()`

### Step 3: TurnExecutionState

Files:

- new `src/agent/TurnExecutionState.ts`
- update `src/agent/TurnExecutor.ts`
- update `src/agent/TurnContext.ts` (remove `turnCount` and `tokenUsage`)
- update `src/agent/ActiveTurn.ts`
- delete `src/agent/TurnState.ts` (replaced by TurnExecutionState)

Work:

- define TurnExecutionState as a replacement for TurnState, absorbing `turnCount` and `tokenUsage` from TurnContext
- TurnExecutionState replaces TurnState — it is not a wrapper or a second object tracking the same counters
- update ActiveTurn to create `executionState: TurnExecutionState` in its constructor (replacing `turnState: TurnState`)
- update TurnContext to remove `turnCount` and `tokenUsage` (these move to TurnExecutionState); TurnContext keeps request identity + messages
- update TurnExecutor to create a local fallback: `const executionState = activeTurn?.executionState ?? new TurnExecutionState()` and use that variable throughout the ReAct loop (replaces direct `activeTurn?.turnState` calls and `context.turnCount` / `context.tokenUsage` usage)
- main path unchanged: SessionRuntime creates ActiveTurn → ActiveTurn creates TurnExecutionState → SessionRuntime passes ActiveTurn to TurnExecutor; forked agents, subagents, and tests that call `run()` without `activeTurn` use the local fallback transparently
- disposed at turn end (completion or failure) when SessionRuntime clears `this.activeTurn` — not stored in the global store

### Step 4: RuntimeObservers

Files:

- new `src/agent/RuntimeObservers.ts`
- update `src/agent/Agent.ts`

Work:

- implement `onRuntimeStateChange` as a single function with explicit field-diff if-checks
- wire it as the `onChange` callback when creating the store
- use listener registration for side effect implementations (metrics or diagnostics)
- scope the observer strictly to **observational side effects**: active-request-count metrics (activeRequestCount), drain-started metrics (draining)
- do NOT route lifecycle control flow through the observer: dequeuing (startNext), drain cascade (beginDrain → sessionManager → fork abort), session eviction — these remain as direct calls in their owning components
- do NOT route rollout recording through the observer — it stays as direct calls from SessionRuntime where per-turn context is available

**Day-one reality:** There is no metrics system in the codebase today (no Prometheus, no OpenTelemetry). The observer on day one should therefore be a no-op plus listener-registration wiring for tests, not ad hoc logging. The primary value of Step 4 is **establishing the wiring** (store creates with onChange, listener registration pattern, test infrastructure) so that when metrics are added, the hook point exists. If this feels like too little concrete work, Step 4 can be deferred — Steps 1-3 deliver the core value (unified draining, store primitive, TurnExecutionState cleanup) without the observer.

## Testing Strategy

Add tests for:

- store short-circuits on identity-equal state (onChange not called)
- process health correctness (store fields + on-demand reads from Agent, queue, and SessionManager)
- observer fires correct observational side effects for each field diff (registered metrics/diagnostic listeners only)
- observer does NOT fire for lifecycle control flow (no dequeue, no drain cascade, no eviction)
- no duplicate side effects on identical state
- `Agent.beginDrain()` ordering: sets store draining flag, then calls `sessionManager.beginDrain()` to abort forks; SubmissionQueue rejects on next `submit()` by reading store
- draining flag exists in exactly one place (store) — SubmissionQueue and SessionManager read from store, have no local flag
- `Agent.submit()`: store not incremented if `queue.submit()` throws; only dedup Set is rolled back
- active request ID dedup still works (Set on Agent, not just a count in the store)
- TurnExecutionState lifecycle (created at start, disposed at end, not leaked)
- TurnExecutionState local fallback: `TurnExecutor.run()` without `activeTurn` uses a local instance
- TurnState.ts no longer exists — TurnExecutionState is the sole replacement
- listener registration and invocation

## Risks

- creating an oversized central state container — mitigated by keeping the store to two fields (activeRequestCount, draining); queue stats and session stats read on demand
- making observers too generic or too magical — mitigated by using explicit if-checks, not an event bus, and strictly scoping observers to observational side effects
- putting request-scoped state in the global store when it does not need to be observable
- routing lifecycle control flow through the observer — mitigated by the explicit distinction between observational side effects (observer) and lifecycle control (direct calls)
- accumulator state bleeding across instances in tests — mitigated by keeping counters as per-instance fields, not module globals
- building observer infrastructure with no concrete consumers — mitigated by acknowledging Step 4 can be deferred if Steps 1-3 deliver sufficient value

## Success Criteria

- process and request state are easier to inspect
- draining flag exists in exactly one place (the store)
- side effects are more centralized and predictable
- the observer is a readable function with explicit checks, scoped to observational side effects only
- lifecycle control flow (drain cascade, dequeue, eviction) remains as direct calls with explicit ordering
- the runtime remains simple enough for a service, not a product shell
- rollout recording stays in SessionRuntime as direct calls; track 05 (transcript) plugs in via a SessionRuntime-level hook, not the process-level observer
- ownership is clear: Agent owns the store and is the sole writer; SubmissionQueue and SessionManager are readers
