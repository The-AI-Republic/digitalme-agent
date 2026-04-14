# Track 06 -- Runtime State and Observers Remediation Plan

## Status

Track 06 is effectively complete. There is no meaningful feature implementation left in this track.

The remaining work is **cleanup required to make the repo consistent with the landed design**.

## Validated Remaining Gaps

### Gap 1: stale `TurnState` test file

- `src/agent/TurnState.ts` has been deleted as intended.
- `src/agent/TurnState.test.ts` still exists and imports the deleted module.
- Impact:
  - breaks the test suite
  - misrepresents the current architecture by testing a removed type

### Gap 2: stale `shutdown` test file

- `src/agent/shutdown.ts` has been deleted as intended.
- `src/agent/shutdown.test.ts` still exists and imports the deleted module.
- Impact:
  - breaks the test suite
  - suggests the old duplicated drain-state design is still present

## Remediation Scope

This pass should do only two things:

1. delete or replace the stale tests that reference removed modules
2. confirm current runtime-state coverage remains intact through the new modules

There is no subsystem redesign required here.

## Implementation Plan

### Step 1: remove stale tests

**Target files**
- `src/agent/TurnState.test.ts`
- `src/agent/shutdown.test.ts`

**Changes**
- Delete both files unless there is specific behavior that still needs coverage under the new architecture.

**Acceptance criteria**
- No test imports `./TurnState.js` or `./shutdown.js`.
- The repo no longer carries tests for deleted runtime-state modules.

### Step 2: verify replacement coverage is sufficient

**Target files**
- `src/agent/TurnExecutionState.test.ts`
- `src/agent/ProcessRuntimeState.test.ts`
- `src/agent/RuntimeObservers.test.ts`
- `src/agent/Agent.test.ts`

**Changes**
- Confirm existing tests already cover the behavior formerly represented by the stale files.
- Add targeted assertions only if a real behavioral gap exists after deleting the stale tests.

**Acceptance criteria**
- The current architecture is tested through current modules, not historical ones.
- No replacement tests are added unless they cover behavior that is actually untested today.

## Test Plan

Run at minimum:

- `node --loader ts-node/esm --test src/agent/TurnExecutionState.test.ts`
- `node --loader ts-node/esm --test src/agent/ProcessRuntimeState.test.ts`
- `node --loader ts-node/esm --test src/agent/RuntimeObservers.test.ts`
- `node --loader ts-node/esm --test src/agent/Agent.test.ts`

## Out of Scope

- Reworking runtime-store ownership
- Changing observer semantics
- Reopening the TurnExecutionState migration

## Source References

- Gap analysis source: `gaps_0413/track_06_runtime_state_and_observers.md` (this file supersedes the earlier wording)
- Original design: `agent_improvements/06_runtime_state_and_observers/IMPLEMENTATION_PLAN.md`
- Original task inventory: `agent_improvements/06_runtime_state_and_observers/tasks.md`
