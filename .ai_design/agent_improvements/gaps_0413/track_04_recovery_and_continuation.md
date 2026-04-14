# Track 04 -- Recovery and Continuation Remediation Plan

## Status

Track 04 is functionally implemented. The remaining work is **semantic completion and cleanup** around recovery state, terminal behavior, and test depth.

This document focuses only on validated work that still needs to happen.

## Validated Remaining Gaps

### Gap 1: `RecoveryState` is incomplete relative to the design

- `src/agent/types/recovery.ts` is missing `apiRetryCount`.
- The current runtime still retries correctly, but the state contract no longer matches the original design.
- Risk:
  - recovery bookkeeping is split between loop locals and recovery state
  - future observability/debugging will have less explicit state

### Gap 2: `model_error` and `aborted` terminal reasons are defined but unused

- `TurnExecutor` still throws on unrecoverable model errors and aborts.
- The design called for explicit terminal semantics rather than contradictory `done` + throw behavior.
- Risk:
  - event consumers cannot rely on terminal reason coverage
  - shutdown/abort behavior remains less inspectable than intended

### Gap 3: `IModelClientFactory.createFromConfig` is still optional

- The concrete factory implements it.
- The interface keeps it optional, forcing fallback logic to branch defensively.
- Risk:
  - the fallback path treats a required capability as optional

### Gap 4: recovery test coverage is thin in a few critical places

- `src/agent/types/recovery.test.ts` exists, so the issue is not “no tests.”
- Remaining gaps:
  - no isolated tests for `callModelWithRecovery()`
  - no direct tests for terminal-reason semantics on hard model failure / abort
  - backoff tests still use real timers rather than fake timers

## Remediation Scope

Implement the following only:

1. Finish the recovery state contract.
2. Make terminal reasons authoritative for hard-stop cases.
3. Tighten the model factory interface.
4. Add focused recovery tests.

Do **not** redesign the already-working distributed recovery structure.

## Implementation Plan

### Step 1: Complete the `RecoveryState` contract

**Target files**
- `src/agent/types/recovery.ts`
- `src/agent/types/recovery.test.ts`
- `src/agent/TurnExecutor.ts`

**Changes**
- Add `apiRetryCount` back to `RecoveryState`.
- Initialize it in `initialRecoveryState()`.
- Increment it on retry.
- Reset it when fallback succeeds or when a model call succeeds, depending on the intended semantics chosen in code comments.

**Acceptance criteria**
- `RecoveryState` once again matches the design contract for retry bookkeeping.
- Tests assert the zeroed initial state, including `apiRetryCount`.

### Step 2: Use terminal reasons for hard-stop error and abort paths

**Target files**
- `src/agent/TurnExecutor.ts`
- `src/agent/types.ts`
- relevant tests under `src/agent/`

**Changes**
- For unrecoverable model failure:
  - emit `done` with `terminalReason: { reason: 'model_error', error: ... }`
  - return a terminal result or propagate only if there is a strong existing API contract that requires throw semantics
- For abort handling:
  - translate request aborts into `terminalReason: { reason: 'aborted', phase: ... }`
  - keep phase semantics concrete and documented

**Acceptance criteria**
- `model_error` is no longer dead type surface.
- `aborted` is no longer dead type surface.
- Event consumers can observe terminal reason coverage for these paths.

### Step 3: Tighten the factory interface

**Target files**
- `src/models/ModelClientFactory.ts`
- any tests that stub `IModelClientFactory`

**Changes**
- Make `createFromConfig(modelConfig)` required on `IModelClientFactory`.
- Update any test doubles accordingly.

**Acceptance criteria**
- Fallback logic does not need `if (createFromConfig)` style defensive branching.
- Interface matches actual runtime expectations.

### Step 4: Add focused recovery tests

**Target files**
- `src/agent/TurnExecutor.recovery.test.ts`
- `src/agent/apiRetry.test.ts`
- optionally new focused tests if isolation is cleaner than expanding existing files

**Changes**
- Add tests for:
  - retry bookkeeping / `apiRetryCount`
  - unrecoverable model error terminal semantics
  - abort terminal semantics
  - `callModelWithRecovery()` fallback path, if practical through a focused harness
- Convert backoff timing tests to fake timers if the test framework support is acceptable; otherwise document why real timers remain.

**Acceptance criteria**
- Recovery behavior is validated at the semantic level, not only through broad loop tests.
- The remaining recovery gaps are genuinely closed rather than only documented.

## Test Plan

Run at minimum:

- `node --loader ts-node/esm --test src/agent/types/recovery.test.ts`
- `node --loader ts-node/esm --test src/agent/apiRetry.test.ts`
- `node --loader ts-node/esm --test src/agent/TurnExecutor.recovery.test.ts`
- `node --loader ts-node/esm --test src/agent/TurnExecutor.test.ts`

## Out of Scope

- Replacing the inline/distributed recovery structure with a RecoveryManager
- Reworking reactive compaction architecture
- Reopening fallback model routing decisions already handled by Track 09 integration

## Source References

- Gap analysis source: `gaps_0413/track_04_recovery_and_continuation.md` (this file supersedes the earlier wording)
- Original design: `agent_improvements/04_recovery_and_continuation/IMPLEMENTATION_PLAN.md`
- Original task inventory: `agent_improvements/04_recovery_and_continuation/tasks.md`
