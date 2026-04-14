# Tasks: Runtime State and Observers

Source: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

This track makes runtime ownership clearer without introducing a large shared runtime container.
It covers:

- a minimal process-level runtime store
- one draining flag as the single source of truth
- clearer request-scoped execution state
- removal of duplicated shutdown/drain state
- a narrow observer hook for passive side effects only

Implementation rules for this track:

- Keep the runtime store small: `activeRequestCount` and `draining` only.
- `Agent` is the sole writer to the runtime store.
- Queue state stays in `SubmissionQueue`; session state stays in `SessionManager` / `SessionRuntime`.
- `TurnExecutionState` replaces `TurnState`; do not keep both.
- Do not route lifecycle control flow through observers.
- Step 4 is optional for initial landing; Steps 1-3 deliver the main value.

---

## Step 1: RuntimeStore and ProcessRuntimeState

Everything else depends on the process runtime contracts existing first.

### Runtime store primitive

- [ ] Create `src/agent/RuntimeStore.ts`.
- [ ] Add `createStore<T>(initialState, onChange)` returning:
  - `getState`
  - `setState`
- [ ] Ensure `setState` accepts an updater function `(prev: T) => T`.
- [ ] Ensure `Object.is(next, prev)` short-circuits:
  - state assignment
  - `onChange`
- [ ] Keep the implementation minimal; no `subscribe` API in this track.

### Process runtime state type

- [ ] Create `src/agent/ProcessRuntimeState.ts`.
- [ ] Add `ProcessRuntimeState` interface with:
  - `activeRequestCount: number`
  - `draining: boolean`
- [ ] Add an exported helper or constant for the initial state:
  - `activeRequestCount = 0`
  - `draining = false`

### Validation

- [ ] `createStore()` compiles and is usable from `Agent`.
- [ ] Identity-equal state updates do not call `onChange`.
- [ ] Initial process runtime state is importable and unambiguous.
- [ ] No queue/session/provider-health fields are added to `ProcessRuntimeState`.

---

## Step 2: Unify Process Runtime Ownership in Agent

This step removes duplicated drain state and makes `Agent` the store owner.

### Agent store ownership

- [ ] Update `src/agent/Agent.ts` to create the runtime store in the constructor.
- [ ] Add private store field on `Agent`.
- [ ] Keep `activeRequests` as a `Set<string>` on `Agent`.
- [ ] Keep `completedRequests` / `failedRequests` as plain per-instance fields on `Agent`.
- [ ] Update `submit()` to:
  - reject when `store.getState().draining` is true
  - reject duplicate `requestId` using `activeRequests`
  - increment `activeRequestCount` only after `queue.submit()` succeeds
  - decrement `activeRequestCount` in the queue completion callback
  - roll back only the dedup set if `queue.submit()` throws before increment
- [ ] Update `beginDrain()` to:
  - set `draining = true` in the store
  - then call `sessionManager.beginDrain()`
- [ ] Update `getHealth()` to read:
  - `draining` and `activeRequestCount` from the store
  - `completedRequests` / `failedRequests` from Agent fields
  - queue/session stats on demand

### Remove duplicated draining state

- [ ] Delete `src/agent/shutdown.ts`.
- [ ] Remove `ShutdownController` usage from `Agent.ts`.
- [ ] Update `src/agent/SubmissionQueue.ts` to remove:
  - local `draining` field
  - `beginDrain()`
  - `isDraining()`
- [ ] Update `src/agent/SessionManager.ts` to remove:
  - local `draining` field
- [ ] Keep `SessionManager.beginDrain()` public, but make it only abort forked agents.

### Constructor and DI cleanup

- [ ] Replace `queue?: SubmissionQueue` in `AgentDeps` with a factory or equivalent override that can receive `getState`.
- [ ] Construct the production `SubmissionQueue` inside `Agent` with `store.getState`.
- [ ] Construct the production `SessionManager` inside `Agent` with `store.getState`.
- [ ] Keep `sessionManager?: Pick<SessionManager, 'execute' | 'getStats' | 'beginDrain'>` as a test override.
- [ ] Do not require mocked test session managers to read the store.

### Validation

- [ ] There is exactly one draining flag in runtime code: `ProcessRuntimeState.draining`.
- [ ] External submissions are rejected after `beginDrain()`.
- [ ] `SessionManager.beginDrain()` still aborts forked agents.
- [ ] `SubmissionQueue` no longer exposes `beginDrain()` or `isDraining()`.
- [ ] `Agent.submit()` does not overcount requests if `queue.submit()` throws.
- [ ] Duplicate request rejection still works using `activeRequests`.
- [ ] Existing tests that inject a fake `sessionManager` still compile with minimal changes.

---

## Step 3: Thread Store Reads into SubmissionQueue and SessionManager

This step makes queue/session components read the single draining flag without becoming store owners.

### SubmissionQueue integration

- [ ] Update `src/agent/SubmissionQueue.ts` constructor to accept `getState: () => ProcessRuntimeState`.
- [ ] Use `getState().draining` in `submit()` to reject new work.
- [ ] Keep all existing queue ownership local to `SubmissionQueue`:
  - `activeConversations`
  - `pendingByConversation`
  - `activeCount`
- [ ] Keep `startNext()` as direct queue control flow.
- [ ] Keep `getStats()` pull-based.
- [ ] Remove `draining` from queue stats output unless still needed for backwards compatibility.

### SessionManager integration

- [ ] Update `src/agent/SessionManager.ts` constructor to accept `getState: () => ProcessRuntimeState`.
- [ ] Use `getState().draining` in `execute()` to reject new work.
- [ ] Keep session eviction and cleanup logic in `SessionManager`.
- [ ] Keep `getStats()` pull-based.
- [ ] Keep `beginDrain()` limited to aborting forked agents.

### Validation

- [ ] `SubmissionQueue` rejects new submissions when store draining is true.
- [ ] `SessionManager.execute()` rejects new work when store draining is true.
- [ ] Queue concurrency and FIFO behavior remain unchanged.
- [ ] Session eviction behavior remains unchanged outside drain-state ownership.
- [ ] No store writes occur outside `Agent`.

---

## Step 4: TurnExecutionState Refactor

This step cleans up per-request execution state ownership.

### New execution state type

- [ ] Create `src/agent/TurnExecutionState.ts`.
- [ ] Move execution-tracking responsibilities from `TurnState` into `TurnExecutionState`.
- [ ] Include fields/behavior for:
  - iteration/model-turn tracking
  - tool call count
  - pending tool call IDs
  - token usage
- [ ] Do not add future-only fields unless their producer APIs already exist.

### ActiveTurn integration

- [ ] Update `src/agent/ActiveTurn.ts` to replace `turnState` with `executionState`.
- [ ] Ensure `ActiveTurn` constructs `TurnExecutionState` in its constructor.
- [ ] Update `snapshot()` to expose execution-state data under a stable field name.
- [ ] Keep lifecycle fields unchanged:
  - `status`
  - `startedAt`
  - `completedAt`
  - `errorMessage`

### TurnContext cleanup

- [ ] Update `src/agent/TurnContext.ts` to remove:
  - `turnCount`
  - `tokenUsage`
- [ ] Keep only request identity plus accumulated messages in `TurnContext`.

### TurnExecutor integration

- [ ] Update `src/agent/TurnExecutor.ts` to use:
  - `activeTurn?.executionState`
  - local fallback `new TurnExecutionState()` when `activeTurn` is absent
- [ ] Replace all direct `activeTurn?.turnState` usage.
- [ ] Replace all `context.turnCount` usage with `executionState`.
- [ ] Replace all `context.tokenUsage` usage with `executionState`.
- [ ] Ensure `prepareContextForModelCall()` still receives the latest token usage.
- [ ] Ensure returned `completedTurns` still reflects the correct iteration count.

### Remove old type

- [ ] Delete `src/agent/TurnState.ts`.
- [ ] Remove all imports of `TurnState`.

### Validation

- [ ] Main path still works: `SessionRuntime` creates `ActiveTurn`, executor uses `activeTurn.executionState`.
- [ ] Forked agents still work without `activeTurn` using the local fallback.
- [ ] Subagents still work without `activeTurn` using the local fallback.
- [ ] `ActiveTurn.snapshot()` still contains execution details needed by rollout recording.
- [ ] No duplicated turn-tracking object remains after the refactor.

---

## Step 5: RuntimeObservers (Optional Initial Landing)

This step adds the hook point for passive side effects only. It can be deferred if Steps 1-4 are landed first.

### Observer module

- [ ] Create `src/agent/RuntimeObservers.ts`.
- [ ] Export `onRuntimeStateChange(oldState, newState)`.
- [ ] Implement explicit field diffs only:
  - `activeRequestCount`
  - `draining`
- [ ] Use listener registration for passive side effects.
- [ ] Keep the default day-one implementation as no-op wiring unless a real consumer exists.

### Agent wiring

- [ ] Pass `onRuntimeStateChange` as the store `onChange` callback from `Agent`.
- [ ] Ensure observers do not write back into runtime control flow.

### Explicit non-goals

- [ ] Do not move `SubmissionQueue.startNext()` into observers.
- [ ] Do not move `Agent.beginDrain()` cascade into observers.
- [ ] Do not move session eviction into observers.
- [ ] Do not move `RolloutRecorder.record()` into observers.
- [ ] Do not introduce a generic event bus.

### Validation

- [ ] Listener fires when `activeRequestCount` changes.
- [ ] Listener fires when `draining` changes.
- [ ] No listener fires on identity-equal store updates.
- [ ] Observer remains passive and does not affect request correctness.

---

## Cross-Cutting Tests

- [ ] Add unit tests for `RuntimeStore`.
- [ ] Add/update tests for `Agent.submit()` request counting behavior.
- [ ] Add/update tests for drain behavior across `Agent`, `SubmissionQueue`, and `SessionManager`.
- [ ] Add/update tests for `getHealth()` using store values plus pull-based queue/session stats.
- [ ] Add/update tests for `TurnExecutionState` lifecycle.
- [ ] Add/update tests for executor fallback behavior without `activeTurn`.
- [ ] Add observer tests only if Step 5 lands.

---

## Rollout Order

1. Land `RuntimeStore` and `ProcessRuntimeState` (Step 1).
2. Land `Agent` ownership + drain unification (Step 2).
3. Land queue/session read-path integration (Step 3).
4. Land `TurnExecutionState` refactor (Step 4).
5. Land `RuntimeObservers` only if needed now (Step 5).

## Done Criteria

- [ ] `draining` exists in exactly one place.
- [ ] `Agent` is the sole runtime-store writer.
- [ ] Queue/session stats remain owned by their existing components.
- [ ] Turn execution state is no longer split across `TurnContext` and `TurnState`.
- [ ] Duplicate request rejection still works.
- [ ] Health remains pull-based and accurate.
- [ ] No lifecycle control flow is routed through observers.
