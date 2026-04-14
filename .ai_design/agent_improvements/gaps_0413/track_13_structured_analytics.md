# Track 13: Structured Analytics -- Gap Analysis

## Status: DEFERRED (Confirmed)

No dedicated Track 13 implementation exists. However, Track 07 OTEL work provides significant partial coverage.

---

## OTEL Coverage (from Track 07)

| Track 13 Component | Status | Notes |
|---|---|---|
| Turn/model/tool/fork/hook counters | **Covered** | `src/telemetry/metrics.ts` |
| Active sessions gauge | **Covered** | ObservableGauge in `src/index.ts` |
| Instrumentation in TurnExecutor | **Covered** | `recordTurnCompleted`, `recordModelCall`, `recordTokens`, `recordToolCall`, `recordError` |
| PII-safe attributes | **Covered** | `src/telemetry/attributes.ts` with allowlist |

## Remaining Gaps (if activated)

| Component | Status | Impact |
|---|---|---|
| `PerformanceProfiler` (per-turn phase breakdown) | NOT IMPLEMENTED | Most impactful for latency debugging |
| `ErrorBuffer` (in-memory ring buffer) | NOT IMPLEMENTED | Useful for diagnostics without log diving |
| `MetricsAggregator` (rolling window percentiles) | NOT IMPLEMENTED | OTEL backends may already provide this |
| Enhanced `/health` endpoint | NOT IMPLEMENTED | No operational metrics in health response |
| `MetricsLogger` with pluggable sinks | NOT IMPLEMENTED | OTEL exporters likely sufficient |
| PII-safe metadata types | NOT IMPLEMENTED | Type-level enforcement missing |

## Recommendation

OTEL work has reduced this track's scope by ~40%. If activated, focus on:
1. `PerformanceProfiler` -- per-turn phase latency breakdown
2. `ErrorBuffer` -- recent errors in `/health`
3. `MetricsAggregator` -- rolling percentiles/rates
4. Enhanced `/health` endpoint

The custom `MetricsSink` interface is likely unnecessary given OTEL's exporter ecosystem.
