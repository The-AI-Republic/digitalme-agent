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

## Claudy Patterns Worth Borrowing

Relevant source references:

- `/home/rich/dev/study/claudy/src/state/AppStateStore.ts`
- `/home/rich/dev/study/claudy/src/state/onChangeAppState.ts`
- `/home/rich/dev/study/claudy/src/state/store.ts`

The most important transferable pattern is not “have a giant app state.”

The most important pattern is:

- one store-like mutation path
- one `onChange`-style choke point reacting to state diffs
- side effects not scattered throughout request execution

## Target Design for DigitalMe Agent

### New Modules

- `src/agent/ProcessRuntimeState.ts`
  - queue pressure, active conversations, draining, provider health
- `src/agent/TurnExecutionState.ts`
  - request-scoped runtime execution state
- `src/agent/RuntimeObservers.ts`
  - the main onChange-style side-effect choke point

### Existing Files To Change

- `src/agent/Agent.ts`
- `src/agent/SessionManager.ts`
- `src/agent/SessionRuntime.ts`
- `src/agent/TurnExecutor.ts`

## Suggested State Split

### Process Runtime State

Belongs in `ProcessRuntimeState.ts`:

- active request count
- active conversation count
- queue pressure
- draining state
- current provider/model health
- heartbeat status

### Conversation Runtime State

Mostly remains in `SessionState.ts`, but should be made more explicit:

- canonical history
- prompt history
- summary memory
- recent tool outcomes
- last projection metadata

### Turn Execution State

Belongs in `TurnExecutionState.ts`:

- iteration index
- estimated prompt size
- continuation reason
- terminal reason
- active tool calls
- retry counts

## Observer Model

`RuntimeObservers.ts` should be the main side-effect choke point.

It should react to state diffs and handle things like:

- health snapshot updates
- metrics emission
- heartbeat transitions
- cleanup triggers
- transcript/rollout side effects where appropriate

It should not become a broad event bus for arbitrary features.

## Suggested Implementation Sequence

### Step 1: ProcessRuntimeState

Files:

- new `src/agent/ProcessRuntimeState.ts`
- update `src/agent/Agent.ts`

Work:

- centralize process counters
- centralize health snapshot generation

### Step 2: TurnExecutionState

Files:

- new `src/agent/TurnExecutionState.ts`
- update `src/agent/TurnExecutor.ts`

Work:

- move important request-scoped execution state out of scattered local variables

### Step 3: RuntimeObservers

Files:

- new `src/agent/RuntimeObservers.ts`
- update `src/agent/Agent.ts`
- update `src/agent/SessionManager.ts`

Work:

- make runtime side effects react to state diffs through one choke point

## Testing Strategy

Add tests for:

- process health snapshot correctness
- state diff observer invocation
- no duplicate side effects on identical state
- cleanup/heartbeat reactions on relevant state changes

## Risks

- creating an oversized central state container
- making observers too generic or too magical
- duplicating the same fact in multiple state objects

## Success Criteria

- process and request state are easier to inspect
- side effects are more centralized and predictable
- the runtime remains simple enough for a service, not a product shell

