# 13 — Structured Analytics and Operational Metrics Tasks [deferred]

## Step 1: Event Types and Logger

- [ ] Define typed metric events in `src/metrics/types.ts` (TurnCompleted, ModelCall, ToolExecution, Error, etc.)
- [ ] Define PII-safe metadata type with enforcement rules
- [ ] Add `src/metrics/MetricsLogger.ts` — core logging function
- [ ] Add `src/metrics/sinks/StdoutSink.ts` — structured JSON log output
- [ ] Add `MetricsSink` interface for pluggable export

## Step 2: Turn and Model Call Instrumentation

- [ ] Add timing instrumentation to `TurnExecutor.ts` for turn-level metrics
- [ ] Add timing instrumentation to model call path
- [ ] Emit `turn_completed` events with latency breakdown
- [ ] Emit `model_call` events with token usage and status
- [ ] Emit `tool_execution` events with timing and results

## Step 3: Performance Profiler

- [ ] Add `src/metrics/PerformanceProfiler.ts` with checkpoint/measure API
- [ ] Integrate checkpoints into turn execution path:
  - turn_start, prompt_projection_done, model_call_start/done, tool_execution_start/done, turn_done
- [ ] Generate profiler report per turn
- [ ] Include profiler report in turn transcript (track 05)

## Step 4: Error Buffer

- [ ] Add `src/metrics/ErrorBuffer.ts` — ring buffer (max 100 entries)
- [ ] Capture errors from: model calls, tool execution, config loading, guardrails
- [ ] Store: timestamp, message, stack (internal only), context
- [ ] Expose recent errors via `/health` endpoint (messages only, no stacks)

## Step 5: Metrics Aggregation

- [ ] Add `src/metrics/MetricsAggregator.ts`
- [ ] Implement rolling window aggregation (1min, 5min, 1hr)
- [ ] Compute: throughput, latency percentiles, error rates, cost rates
- [ ] Expose via enhanced `/health` or new `/metrics` endpoint

## Step 6: Health Endpoint Enhancement

- [ ] Extend `/health` response with operational metrics summary
- [ ] Include: active conversations, turn rate, avg latency, error rate, fallback status
- [ ] Include: recent errors from error buffer
- [ ] Keep response size bounded (summary only, not full history)
