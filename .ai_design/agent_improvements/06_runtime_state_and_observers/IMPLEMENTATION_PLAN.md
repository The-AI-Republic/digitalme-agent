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
- Rollout recording called inline from SessionRuntime, not through any observer

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

## Target Design for DigitalMe Agent

### New Modules

- `src/agent/RuntimeStore.ts`
  - the store primitive: `createStore(initialState, onChange)` with `getState` / `setState`
  - `Object.is` short-circuit on identity-equal state
- `src/agent/ProcessRuntimeState.ts`
  - queue pressure, active conversations, draining, provider health
- `src/agent/TurnExecutionState.ts`
  - request-scoped runtime execution state
- `src/agent/RuntimeObservers.ts`
  - single `onRuntimeStateChange(oldState, newState)` function with explicit field-diff checks

### Existing Files To Change

- `src/agent/Agent.ts`
- `src/agent/SessionManager.ts`
- `src/agent/SessionRuntime.ts`
- `src/agent/TurnExecutor.ts`

## Suggested State Split

### Process Runtime State (in the store, observable)

Belongs in `ProcessRuntimeState.ts`:

- active request count (replaces `Agent.activeRequests`)
- active conversation count (replaces `SubmissionQueue.activeConversations`)
- queue pressure (replaces `SubmissionQueue.pendingByConversation` depth)
- draining state (single source of truth — replaces four duplicated flags)
- current provider/model health

### Process Accumulator State (outside the store, not observable)

Does not belong in the reactive store:

- cumulative completed/failed request counters (`Agent.completedRequests`, `Agent.failedRequests`)
- timing accumulators (total API duration, total tool duration)
- session identity (agentId, startup timestamp)
- caches

These are read on demand (e.g. health endpoint), never observed.

### Conversation Runtime State

Mostly remains in `SessionState.ts`, but should be made more explicit:

- canonical history
- prompt history
- summary memory
- recent tool outcomes
- last projection metadata

### Turn Execution State

Belongs in `TurnExecutionState.ts`:

- iteration index (from `TurnContext.turnCount`)
- model turn count (from `TurnState.modelTurnCount`)
- tool call count (from `TurnState.toolCallCount`)
- pending tool call IDs (from `TurnState.pendingToolCallIds`)
- token usage (from `TurnContext.tokenUsage`)
- estimated prompt size
- continuation reason
- terminal reason

#### Lifecycle

- Created by `TurnExecutor` at the start of each turn
- Owned by `TurnExecutor` — passed as a parameter, not stored in the global store
- Disposed at turn end (completion or failure)
- Not observable via the store — the agent has no UI that needs to react to per-turn progress

This is a short-lived request-scoped object, not part of the reactive store. The store only needs to know about process-level facts (active request count changed) and conversation-level facts, not per-iteration execution details.

## Observer Model

`RuntimeObservers.ts` should export a single concrete function:

```typescript
function onRuntimeStateChange(oldState: ProcessRuntimeState, newState: ProcessRuntimeState): void
```

It should contain explicit field-diff checks, not an abstract observer registry:

```
if activeRequestCount changed → update health snapshot
if draining changed → trigger cleanup sequence
if providerHealth changed → emit metrics
if activeConversationCount changed → update queue pressure metrics
```

Side effects should call through registered listeners (set once at startup), not directly import metrics or health implementations. This keeps the observer testable.

It should not become a broad event bus for arbitrary features.

### Integration with Track 05 (Transcript and Artifact Storage)

`onRuntimeStateChange` is the natural hook point for transcript recording from track 05. When track 05 is implemented, rollout recording side effects currently called inline from `SessionRuntime` should be rewired through the observer. This is not a dependency — 06 can land first, and 05 plugs in later.

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

Work:

- define the ProcessRuntimeState type
- centralize process counters into the store
- unify the four duplicated draining flags into one
- centralize health snapshot generation
- move cumulative counters (completed/failed) to plain module state outside the store

### Step 3: TurnExecutionState

Files:

- new `src/agent/TurnExecutionState.ts`
- update `src/agent/TurnExecutor.ts`

Work:

- define the TurnExecutionState type with clear lifecycle (create at turn start, dispose at turn end)
- move important request-scoped execution state out of scattered local variables
- TurnExecutor creates and owns the instance — not stored in the global store

### Step 4: RuntimeObservers

Files:

- new `src/agent/RuntimeObservers.ts`
- update `src/agent/Agent.ts`
- update `src/agent/SessionManager.ts`

Work:

- implement `onRuntimeStateChange` as a single function with explicit field-diff if-checks
- wire it as the `onChange` callback when creating the store
- use listener registration for side effect implementations (metrics, health, cleanup)
- migrate scattered side effects through the observer

## Testing Strategy

Add tests for:

- store short-circuits on identity-equal state (onChange not called)
- process health snapshot correctness
- observer fires correct side effects for each field diff
- no duplicate side effects on identical state
- cleanup/draining reactions on relevant state changes
- TurnExecutionState lifecycle (created at start, disposed at end, not leaked)
- listener registration and invocation

## Risks

- creating an oversized central state container — mitigated by keeping accumulators and caches outside the store
- making observers too generic or too magical — mitigated by using explicit if-checks, not an event bus
- duplicating the same fact in multiple state objects — mitigated by the audit mapping each fact to exactly one location
- putting request-scoped state in the global store when it does not need to be observable

## Success Criteria

- process and request state are easier to inspect
- draining flag exists in exactly one place
- side effects are more centralized and predictable
- the observer is a readable function with explicit checks, not an abstract framework
- the runtime remains simple enough for a service, not a product shell
- track 05 (transcript) has a clean hook point when it is ready

