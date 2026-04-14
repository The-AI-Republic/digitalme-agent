# Track 07: Internal Events and Observability -- Gap Analysis

## Summary

Track 07 is substantially complete. OpenTelemetry instrumentation (traces, spans, metrics) is in place. Fork, subagent, and hook observability are fully implemented with comprehensive tests. A few gaps remain: stale test files, tool spans not wired into ToolExecutor, and missing `compact_started` event type.

---

## Step 1: Remove RolloutRecorder

**Status: PARTIAL**

- `src/agent/RolloutRecorder.ts` deleted -- YES
- `src/agent/RolloutRecorder.test.ts` still exists -- **BUG**
- `src/agent/SessionRuntime.test.ts` still imports `RolloutEntry` -- **BUG**

---

## Step 2: Forked Agent Observability

**Status: YES**

All fork lifecycle types, transcript recording, OTEL spans, and metrics implemented. Comprehensive test coverage.

---

## Step 3: Subagent Observability

**Status: YES**

All subagent lifecycle types, sidechain recording, OTEL spans implemented. Comprehensive test coverage.

---

## Step 4: Post-Turn Hook Observability

**Status: YES**

`HookTimeoutError`, `HookExecutedEntry`, OTEL spans, and metrics all implemented. `SLOW_HOOK_THRESHOLD_MS = 2000` exported but not used in logic (minor).

---

## Step 5: OTEL Instrumentation Setup

**Status: YES (with minor gaps)**

- `initTelemetry()` / `shutdownTelemetry()` implemented
- `BasicTracerProvider` with `OTLPTraceExporter`
- `MeterProvider` with 60s interval
- Endpoint hardcoded to `https://otel.airepublic.com/v1`
- Agent identity via `SHA-256(auth.api_key)`

**Missing:**
1. No explicit `NoopExporter` fallback (relies on OTEL SDK default)
2. `deploymentHost` not passed in `src/index.ts` (defaults to `'unknown'`)

---

## Step 6: Span Instrumentation

**Status: PARTIAL**

All span helpers implemented and tested:
- `startInteractionSpan`, `startModelCallSpan`, `startToolSpan`, `startSubagentSpan`, `startForkSpan`, `startHookSpan`
- Fork/hook spans correctly use linked roots
- Model/tool spans correctly use parent-child

**Gap:** `startToolSpan` is defined but **NOT wired into `ToolExecutor.ts`**. Tool executions produce metrics but no OTEL spans, reducing trace granularity.

---

## Step 7: Metrics Instrumentation

**Status: YES**

All counters and histograms implemented: `agent.turns.*`, `agent.model_calls.*`, `agent.tool_calls.*`, `agent.forks.*`, `agent.hooks.*`, `agent.errors.*`, `agent.sessions.active` (ObservableGauge).

---

## Step 8: PII-Safe Attribute Helpers

**Status: YES**

`safeAttributes()` with allowlist-based filtering. Comprehensive tests.

---

## Step 9: Context Pressure Events

**Status: PARTIAL**

- `compact_completed` event type and recording -- YES
- `compact_started` event type -- **NO** (design specified two-phase tracking)

---

## Step 10: Clean Up and Verify

**Status: PARTIAL**

- TranscriptEntry union is exhaustive for implemented types
- OTEL wired with graceful shutdown
- PII-safe attributes enforced

**Remaining:** Stale RolloutRecorder artifacts.

---

## Priority Remediation

1. **HIGH** -- Delete `RolloutRecorder.test.ts`, fix `SessionRuntime.test.ts` import
2. **MEDIUM** -- Wire `startToolSpan` into `ToolExecutor.ts`
3. **LOW** -- Add `compact_started` event type
4. **LOW** -- Pass `deploymentHost` to `initTelemetry()`
