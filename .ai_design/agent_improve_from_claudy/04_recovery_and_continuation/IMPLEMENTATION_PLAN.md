# Recovery and Continuation

## Goal

Make request execution continuation and retry behavior explicit, bounded, and inspectable.

This track should make `digitalme-agent` better at:

- recovering from model or context failures
- continuing long responses cleanly
- avoiding retry death spirals
- recording why the runtime took another loop iteration

## Current State

Today the main request loop lives in:

- `src/agent/TurnExecutor.ts`

The current loop is structurally correct, but recovery behavior is still relatively simple:

- final text -> done
- tool calls -> execute tools -> continue
- max turns -> fail

That is not enough once prompt compaction, larger outputs, or provider fallback become important.

## Claudy Patterns Worth Borrowing

Relevant source references:

- `/home/rich/dev/study/claudy/src/query.ts`

The key pattern is not “retry on failure.” The key pattern is explicit continuation reasons with guards.

Useful recovery classes:

- normal tool-result continuation
- fallback model retry
- overflow recovery after prompt-too-long
- max-output continuation
- bounded retry counts
- terminal reasons

## Target Design for DigitalMe Agent

### New Modules

- `src/agent/RecoveryManager.ts`
  - owns retry and continuation decisions
- `src/agent/types/recovery.ts`
  - continuation reasons, retry state, terminal reasons

### Existing Files To Change

- `src/agent/TurnExecutor.ts`
- `src/agent/types.ts`

## Suggested Runtime Model

Each request execution should track:

- `iterationIndex`
- `continuationReason`
- `terminalReason`
- `fallbackAttempted`
- `hasAttemptedReactiveCompact`
- `maxOutputContinuationCount`

That state should be visible to:

- transcript recording
- internal events
- health/observability

## Recommended Recovery Paths

### 1. Normal Tool-Result Continuation

This already exists conceptually.

It should become explicit:

- record why the loop continued
- record which tools caused the continuation

### 2. Overflow Recovery

When prompt projection still produces too much context:

- run `ReactiveCompact`
- retry once or within a bounded count
- record the continuation reason

### 3. Fallback Model Retry

If configured:

- retry using a designated fallback model
- do not loop indefinitely across providers

### 4. Max-Output Continuation

If the model runs out of output budget but clearly has more work:

- append a continuation or “resume mid-thought” instruction
- continue the request loop
- bound the continuation count

## Suggested Implementation Sequence

### Step 1: Recovery State Types

Files:

- new `src/agent/types/recovery.ts`
- update `src/agent/types.ts`

Work:

- define continuation reasons
- define terminal reasons
- define bounded retry counters

### Step 2: RecoveryManager

Files:

- new `src/agent/RecoveryManager.ts`
- update `src/agent/TurnExecutor.ts`

Work:

- route continuation decisions through one helper
- avoid scattered retry logic

### Step 3: Wire the First Recovery Paths

Implement in order:

1. normal tool-result continuation metadata
2. overflow recovery
3. fallback model retry
4. max-output continuation

## Testing Strategy

Add tests for:

- overflow recovery is bounded
- fallback is attempted at most once where configured
- continuation messages increase iteration count but do not lose prior state
- terminal reasons are stable and visible in output metadata

## Risks

- too many recovery branches making the loop unreadable
- retries mutating prompt state in inconsistent ways
- adding fallback before prompt/projection state is stable

## Success Criteria

- continuation and retry behavior is explicit
- every extra loop iteration has a recorded reason
- retry loops are bounded and testable

