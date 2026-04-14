# Track 02: Context Management -- Gap Analysis

## Summary

The foundational modules (Steps 1-2) are substantially implemented with good test coverage. Steps 3-5 modules exist as standalone implementations but are **not wired into the pipeline** or the TurnExecutor. The `prepareContextForModelCall` pipeline currently only runs Steps 1-2 (persistence + microcompact) and explicitly comments "Steps 4-6 (projection, compaction, recovery) will be added in Steps 3-4."

---

## Step 1: TokenBudget + ToolResultPersistence + Message Metadata + Session Cleanup

### Types and Metadata

| Task | Status | Notes |
|------|--------|-------|
| Add `id` to `Message` | YES | Implemented as **required** `id: string`, not `id?: string` as designed. Deviation is arguably an improvement. |
| Add `timestamp` to `Message` | YES | `timestamp?: string` -- optional as designed. |
| `cloneMessage` preserves metadata | YES | Copies `id`, `timestamp`, `synthetic`. |
| Generate metadata for all message types | YES | In `TurnExecutor.run()` and `historyToMessages()`. |
| Metadata does not leak into provider payloads | YES | Provider clients explicitly map only required fields. |

### TokenBudget

| Task | Status | Notes |
|------|--------|-------|
| Create `TokenBudget.ts` | YES | Full implementation. |
| `getEffectiveWindow(modelName)` | YES | |
| `estimateTokens(messages, lastKnownUsage?)` | YES | |
| `assessPressure(modelName, messages, lastKnownUsage?)` | YES | Returns `PressureBand`. |
| Log warning when model metadata missing | **NO** | `resolveModelMetadata` silently falls back to defaults. |
| Unit tests | YES | |

### ToolResultPersistence

| Task | Status | Notes |
|------|--------|-------|
| Create `ToolResultPersistence.ts` | YES | Full implementation. |
| Gate behavior when file-read tool unavailable | **NO** | Always persists regardless of whether model has a read tool. |
| Unit tests | YES | |

### SessionManager Cleanup

| Task | Status | Notes |
|------|--------|-------|
| Startup sweep | YES | `sweepOrphanedTempFiles()` in constructor. |
| Cleanup on TTL/capacity eviction | YES | |
| Abort forked agents before cleanup | YES | |

**Step 1 Verdict: SUBSTANTIALLY COMPLETE.** Two gaps: (1) no warning for missing model metadata, (2) no gating of tool result persistence.

---

## Step 2: Microcompact + Pipeline Shell

**Step 2 Verdict: COMPLETE.** All tasks implemented and tested.

---

## Step 3: SessionMemory Extraction and Lifecycle

### SessionMemory Module

| Task | Status | Notes |
|------|--------|-------|
| Core module | YES | Full implementation with disk-backed storage. |
| `shouldExtract()` | YES | Checks enabled, init threshold, token growth, tool call count. |
| `extract()` as non-blocking fork | PARTIAL | Delegates forking to hook (reasonable deviation). |
| `waitForExtraction(timeoutMs?)` | YES | With stale detection (60s). |
| Serialize extraction (no overlapping) | PARTIAL | Uses flag but no mutex. Low risk since hooks fire sequentially. |

### SessionMemoryHook

| Task | Status | Notes |
|------|--------|-------|
| Restrict fork to Edit tool | **NO** | No tool restriction passed to fork config. |

### SessionRuntime Integration

| Task | Status | Notes |
|------|--------|-------|
| Clear session memory on reseed | **NO** | **BUG** -- session memory persists stale data after platform reseed. |

**Step 3 Verdict: PARTIAL.** Critical bug: session memory not cleared on reseed.

---

## Step 4: SessionMemoryCompact + ConversationSummaryBuilder + PromptProjector + PostCompactRecovery

All individual modules exist and have tests. However:

| Task | Status | Notes |
|------|--------|-------|
| Pipeline Steps 3-6 wired into `prepareContextForModelCall()` | **NO** | **LARGEST GAP.** Pipeline only runs Steps 1-2. |
| SessionMemoryCompact section truncation | **NO** | Missing. |
| ConversationSummaryBuilder model override wiring | **NO** | Config has `summary.model` but not wired through factory. |
| ConversationSummaryBuilder unit tests | **NO** | No test file found. |
| PostCompactRecovery unit tests | **NO** | No test file found. |

**Step 4 Verdict: PARTIAL.** Modules built but dead code -- not wired into pipeline.

---

## Step 5: ReactiveCompact + MaxOutputRecovery

### Two implementations problem

| Aspect | `context/ReactiveCompact.ts` (design target) | `src/agent/reactiveCompact.ts` (actually used) |
|--------|----------------------------------------------|-----------------------------------------------|
| Approach | LLM-based summarization | Simple round-based message dropping |
| Cost | High (LLM call) | Zero (no LLM) |
| Integration | **Not wired** | Used by TurnExecutor on `context_overflow` |

Similarly, `MaxOutputRecovery.ts` in `context/` is not used by TurnExecutor -- inline implementation used instead.

**Step 5 Verdict: PARTIAL.** Design-specified classes are dead code.

---

## Critical Gaps Summary

### Bugs

1. **Session memory not cleared on reseed** (`SessionRuntime.ts`): Stale session memory will pollute future interactions.

### Major Gaps (Functional)

2. **Pipeline Steps 3-6 not wired**: `prepareContextForModelCall()` does not invoke SessionMemoryCompact, ConversationSummaryBuilder, PromptProjector, or PostCompactRecovery.

3. **ReactiveCompact not integrated**: Design-specified `context/ReactiveCompact.ts` (LLM-based) is dead code. TurnExecutor uses simple round-dropping approach.

4. **MaxOutputRecovery not integrated**: `context/MaxOutputRecovery.ts` is dead code. Equivalent logic is inline in TurnExecutor.

### Minor Gaps

5. No warning logged for missing model metadata in TokenBudget.
6. Tool result persistence not gated when file-read tool unavailable.
7. ConversationSummaryBuilder model override not wired.
8. SessionMemoryCompact missing section truncation.
9. Missing unit tests: ConversationSummaryBuilder and PostCompactRecovery.

### Deviations (Acceptable)

- `Message.id` is required rather than optional.
- Types in `context/types.ts` rather than `agent/types/context.ts`.
- SessionMemory extraction delegated to hook rather than self-forking.
