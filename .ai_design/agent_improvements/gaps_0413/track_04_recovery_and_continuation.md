# Track 04: Recovery and Continuation -- Gap Analysis

## Overview

Track 04 is substantially complete with most design goals achieved. All recovery paths (API retry, fallback model, max-output continuation, reactive compaction) are implemented and well-tested.

---

## Step 1: Recovery Types and Event Contracts

| Item | Status | Notes |
|------|--------|-------|
| `ContinuationReason` union | YES | All 5 variants match design. |
| `TerminalReason` union | YES | All 6 variants + bonus `quota_exceeded`. |
| `ApiErrorCategory` union | YES | All 6 categories match. |
| `RecoveryState` interface | PARTIAL | `apiRetryCount` field from design is missing. |
| `RECOVERY_LIMITS` constants | YES | All 3 limits match. |
| `recovery` event type on `AgentEvent` | YES | |
| `done` with `terminalReason` | YES | |
| Unit tests for `recovery.ts` | **NO** | Only tested indirectly. |

---

## Step 2: Config and Model Factory Support for Fallback

| Item | Status | Notes |
|------|--------|-------|
| Reusable `modelSchema` | YES | |
| `fallback_model` config | YES | Optional as designed. |
| `createFromConfig()` on factory | PARTIAL | Declared optional (`?`) on interface -- fragile. |

---

## Step 3: API Error Categorization and Backoff

| Item | Status | Notes |
|------|--------|-------|
| `categorizeApiError()` | YES | Complete duck-typing + message fallback. |
| `exponentialBackoff()` | YES | `100ms * 2^attempt`. |
| Tests | PARTIAL | Use real timers; only 2 of 3 attempts tested. |

---

## Step 4-5: TurnExecutor Recovery Integration

| Item | Status | Notes |
|------|--------|-------|
| `callModelWithRecovery()` | YES | Full implementation. |
| Retry loop with `MAX_API_RETRIES` | YES | |
| Context overflow returns `{ type: 'context_overflow' }` | YES | |
| Auth error throws immediately | YES | |
| Fallback trigger conditions | YES | All 4 conditions checked. |
| Reset retry budget on fallback | YES | |
| `RecoveryError` for buffered events | YES | Good improvement over design. |
| Recovery events emitted | YES | All 4 types. |
| Continuation tracking (`lastTransition`) | YES | |

---

## Step 6: Max-Output Continuation

| Item | Status | Notes |
|------|--------|-------|
| Detect `result.truncated` | YES | |
| Accumulate text across continuations | YES | |
| Bounded by `MAX_OUTPUT_RECOVERY_ATTEMPTS=3` | YES | |
| Exhausted returns `max_output_exhausted` | YES | |
| Partial text emitted as `text_delta` | YES | Good UX improvement. |

---

## Step 7: Reactive Compaction

| Item | Status | Notes |
|------|--------|-------|
| `groupByRound()` | YES | |
| `tryReactiveCompact()` | YES | Drop-middle strategy. |
| Guard with `hasAttemptedReactiveCompact` | YES | |
| Tests | YES | Comprehensive. |

**Note:** Two compaction implementations coexist:
1. `src/agent/reactiveCompact.ts` -- simple, used by TurnExecutor
2. `src/agent/context/ReactiveCompact.ts` -- class-based with LLM summarization, unused

---

## Step 8: Terminal Reason Semantics

| Item | Status | Notes |
|------|--------|-------|
| `completed` terminal reason | YES | |
| `max_turns` graceful return | YES | No throw. |
| `prompt_too_long` terminal reason | YES | |
| `max_output_exhausted` terminal reason | YES | |
| `model_error` terminal reason | **NO** | Defined but never used -- errors still throw. |
| `aborted` terminal reason | **NO** | Defined but never emitted -- abort still throws. |

---

## Step 9: Tests

| Item | Status | Notes |
|------|--------|-------|
| TurnExecutor recovery tests | YES | Comprehensive -- 20+ scenarios. |
| `initialRecoveryState()` unit tests | **NO** | |
| `callModelWithRecovery()` isolated tests | **NO** | Only indirect. |
| `fallback_model` config documentation | **NO** | |

---

## Summary of Gaps

### Missing

1. `apiRetryCount` field on `RecoveryState` (state tracked internally but not persisted).
2. `model_error` terminal reason never used -- errors still throw.
3. `aborted` terminal reason never used -- abort still throws.
4. Unit tests for `recovery.ts` types.
5. `fallback_model` config documentation.
6. Isolated `callModelWithRecovery()` unit tests.

### Partial

1. `createFromConfig` optional on interface -- fragile null check in fallback path.
2. `exponentialBackoff` tests use real timers.
3. Unused class-based recovery modules in `context/` -- need documentation or removal.

### Deviations (Acceptable)

1. `RecoveryError` wrapper -- solves real event-buffering problem.
2. ModelRouter integration -- adds health tracking value.
3. `quota_exceeded` terminal reason -- supports quotas feature.
