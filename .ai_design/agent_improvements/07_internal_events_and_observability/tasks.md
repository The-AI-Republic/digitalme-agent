# 07 — Internal Events and Observability Tasks

## Step 1: Remove RolloutRecorder

- [ ] Verify no code path references `IRolloutRecorder` or `RolloutRecorder`
- [ ] Delete `src/agent/RolloutRecorder.ts`
- [ ] Remove any remaining imports
- [ ] Clean up any test files that reference it

## Step 2: Forked Agent Observability

- [ ] Add `ForkStartedEntry`, `ForkCompletedEntry`, `ForkFailedEntry`, `ForkRejectedEntry` to transcript types
- [ ] Update `TranscriptEntry.type` union
- [ ] Thread `ITranscriptRecorder` into `launchForkedAgent()` params
- [ ] Record `fork_started` after semaphore acquire
- [ ] Record `fork_completed` / `fork_failed` in promise handler (include `durationMs`, `toolCallCount`, `transcriptPath`)
- [ ] Record `fork_rejected` when `tryAcquire()` or `canFork()` fails
- [ ] Optionally use `insertMessageChain()` with `isSidechain: true` for forked agent messages

## Step 3: Subagent Observability

- [ ] Add `SubagentStartedEntry`, `SubagentCompletedEntry`, `SubagentFailedEntry` to transcript types
- [ ] Update `TranscriptEntry.type` union
- [ ] Thread `ITranscriptRecorder` into `SubagentToolDeps`
- [ ] Record lifecycle events around `consumeGenerator()` call (include `durationMs`, `model`)
- [ ] Optionally use `insertMessageChain()` with `isSidechain: true` for subagent messages

## Step 4: Post-Turn Hook Observability

- [ ] Add `HookTimeoutError` class (extends `Error`) — replaces string-based `new Error('hook_timeout')`
- [ ] Update `PostTurnHooks.runAll()` to throw `HookTimeoutError` instead of generic Error
- [ ] Add `HookExecutedEntry` to transcript types with `HookOutcome = 'success' | 'error' | 'timeout'`
- [ ] Classify timeout via `error instanceof HookTimeoutError` — no string matching
- [ ] Add optional `ITranscriptRecorder` to `PostTurnHookRegistry` constructor
- [ ] Record `hook_executed` with outcome, `durationMs`, and optional error
- [ ] Add `SLOW_HOOK_THRESHOLD_MS = 2000` constant
- [ ] Keep fire-and-forget semantics — recording failures must not crash the agent

## Step 5: OTEL Instrumentation Setup

- [ ] Add `src/telemetry/instrumentation.ts` — `initTelemetry()` / `shutdownTelemetry()`
- [ ] Initialize `BasicTracerProvider` with OTLP HTTP exporter
- [ ] Initialize `MeterProvider` with periodic exporter (60s interval)
- [ ] Hardcode AI Republic endpoint (placeholder until real endpoint)
- [ ] Add `NoopExporter` fallback when endpoint unreachable
- [ ] Add `AsyncLocalStorage<SpanContext>` for interaction context propagation
- [ ] Set resource attributes: `service.name`, `service.version`, `deployment.host`
- [ ] Derive agent identity from `SHA-256(auth.api_key)` — no raw key in telemetry, no new config field
- [ ] Wire `initTelemetry()` into agent startup (before `app.listen()`)
- [ ] Refactor `src/index.ts` shutdown to async — current shutdown is synchronous with `process.exit()` inside `server.close()` callback
- [ ] Handle `server.close(callback)` using the existing error-first callback contract already used in tests; if close fails, continue shutdown anyway
- [ ] Wire `shutdownTelemetry()` into async shutdown with 5-second timeout (carved from 30s shutdown budget)
- [ ] Telemetry flush failure must not block shutdown — silently proceed to exit
- [ ] Add `src/telemetry/types.ts` — telemetry type definitions

## Step 6: Span Instrumentation

- [ ] Add `src/telemetry/spans.ts` — span creation helpers
- [ ] Implement child span helpers: `startInteractionSpan()`, `startModelCallSpan()`, `startToolSpan()`, `startSubagentSpan()`
- [ ] Implement linked root span helpers: `startForkSpan()`, `startHookSpan()` — separate roots with SpanLink back to interaction
- [ ] Linked root helpers must accept captured `SpanContext` or a prebuilt `Link`, not a `Span` instance
- [ ] Capture `interactionSpan.spanContext()` while the interaction span is alive and thread that immutable context into fork/hook launch paths
- [ ] Do not retain ended `Span` objects for background work
- [ ] Implement `endSpan()` with attribute recording
- [ ] Wire interaction span into `TurnExecutor` (root span per fan message)
- [ ] Wire model call span into model API call path (tokens, latency, cache stats) — child of interaction
- [ ] Wire tool span into `ToolExecutor` (tool_name, duration, success) — child of interaction
- [ ] Wire subagent span into `SubagentTool` (type, model, duration, tokens) — child of interaction
- [ ] Wire fork span into `ForkedAgent` (duration, tokens, tool count) — linked root, not child
- [ ] Wire hook span into `PostTurnHooks` (name, outcome, duration) — linked root, not child

## Step 7: Metrics Instrumentation

- [ ] Add `src/telemetry/metrics.ts` — metric definitions
- [ ] Define counters: `agent.turns.total`, `agent.model_calls.total`, `agent.model_calls.tokens`, `agent.tool_calls.total`, `agent.forks.total`, `agent.hooks.total`, `agent.errors.total`
- [ ] Define histograms: `agent.turns.duration_ms`, `agent.tool_calls.duration_ms`
- [ ] Define `agent.sessions.active` as `ObservableGauge` backed by `sessionManager.getStats()` callback (pull-based, not push — Track 06 keeps session count as on-demand read)
- [ ] Make the callback owner explicit: either expose `agent.getSessionManager()` to startup wiring or have `Agent` register the observable internally
- [ ] Wire counters into `TurnExecutor`, `ToolExecutor`, `ForkedAgent`, `PostTurnHooks`
- [ ] Label with attributes: `model`, `tool_name`, `fork_label`, `hook_name`, `success`, `error_category`
- [ ] Verify no PII in any metric label

## Step 8: PII-Safe Attribute Helpers

- [ ] Add `src/telemetry/attributes.ts` — `safeAttributes()` builder
- [ ] Strip conversation content, fan names, creator config values
- [ ] Allow only: token counts, latencies, error codes, model names, tool names, enum values
- [ ] Used by span and metric instrumentation in Steps 6-7

**Note:** Structured event logging (typed events, sampling, export pipeline) is owned by Track 13. Track 13 consumes OTEL providers from Step 5.

## Step 9: Context Pressure Events

- [ ] Add `CompactStartedEntry`, `CompactCompletedEntry` to transcript types
- [ ] Record when microcompact, projection, or reactive compact runs
- [ ] Include `trigger` ('reactive' | 'proactive'), `pressureBand`, `messagesRemoved`, `tokensSaved`
- [ ] If `prepareContextForModelCall()` does not already surface `messagesRemoved` / `tokensSaved` for all compaction paths, extend its return type in this track instead of inferring them later
- [ ] Emit as OTEL span events on the parent interaction span

## Step 10: Clean Up and Verify

- [ ] Ensure `TranscriptEntry.type` union is exhaustive for all new types
- [ ] Verify transcript files contain fork/subagent/hook events in integration tests
- [ ] Verify public `AgentEvent` stream is unchanged (SSE contract)
- [ ] Verify OTEL export works when endpoint is reachable
- [ ] Verify graceful degradation when endpoint is unreachable (no errors, no impact)
- [ ] Verify no PII in any exported span, metric, or event
- [ ] Verify fork/hook spans are linked roots (not children) — turn latency unaffected by background work
- [ ] Coordinate with Track 11 (Usage Tracking) to avoid double-counting tokens
- [ ] Coordinate with Track 13 (Structured Analytics) — no duplicate event schemas or sampling policies
