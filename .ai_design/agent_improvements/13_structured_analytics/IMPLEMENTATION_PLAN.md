# 13 — Structured Analytics and Operational Metrics [deferred]

## What This Track Covers

Production-grade metrics collection, performance profiling, operational dashboards, structured event logging for debugging, and PII-safe analytics for product decisions.

## Why This Is Not Covered by Existing Tracks

Track 07 (Internal Events and Observability) designs a richer internal event taxonomy. But events are _raw signals_. This track designs what happens _after_ events: aggregation into metrics, export to monitoring systems, performance profiling, and structured analytics for product and operational insights.

Track 07 says "events can feed metrics" — this track defines _how_.

## What Claudy Does

Claudy has a comprehensive observability stack:

### Structured Analytics (`services/analytics/index.ts`)
- `logEvent(name, metadata)` — core event logging function
- PII-safe metadata type: `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
- Multiple exporters: first-party analytics, Datadog
- Opt-out support: `isAnalyticsDisabled()`
- Event batching and buffering

### Debug Logging (`utils/debug.ts`)
- `logForDebugging(level, key, metadata)` — structured debug logs
- Diagnostic mode: `CLAUDE_CODE_VERBOSE_LOG`
- In-memory error capture: `getInMemoryErrors()` — ring buffer of recent errors
- Startup profiling: `profileCheckpoint()`, `profileReport()` — measure bootstrap latency

### Request Logging
- API request fingerprinting: `captureAPIRequest()` — track each API call
- Response logging: token usage, latency, model, status
- Error reporting: full stack traces with context
- Session replay: complete transcript for debugging

### Performance Profiling
- Startup checkpoint profiling (module load, init, first render)
- Per-query timing breakdown
- Tool execution timing
- Compaction timing and effectiveness

### Key Pattern
Analytics is not an afterthought bolted onto console.log. It's a first-class subsystem with:
1. Typed events with validated metadata
2. PII safety enforcement at the type level
3. Multiple export targets (analytics service, monitoring, debug log)
4. Performance profiling built into the runtime lifecycle

## Current DigitalMe Agent Situation

- `RolloutRecorder.ts` writes JSONL traces — useful for debugging but not analytics
- Track 05 will add richer transcript recording
- No structured metrics (latency, error rates, token usage aggregation)
- No performance profiling (turn latency breakdown, model call timing)
- No metrics export to monitoring systems
- No PII-safe analytics framework
- No in-memory error capture for diagnostics
- Console.log is the primary observability tool

## What To Borrow

### 1. Structured Event Logger

A typed event logging system that replaces ad-hoc console.log:

```typescript
type MetricEvent =
  | TurnStartedEvent
  | TurnCompletedEvent
  | ModelCallEvent
  | ToolExecutionEvent
  | GuardrailEvent
  | ErrorEvent
  | ConfigChangeEvent
  | SessionLifecycleEvent;

interface TurnCompletedEvent {
  type: 'turn_completed';
  timestamp: number;
  conversationId: string;
  creatorId: string;
  metadata: {
    turnNumber: number;
    totalLatencyMs: number;
    modelCallLatencyMs: number;
    toolExecutionLatencyMs: number;
    inputTokens: number;
    outputTokens: number;
    toolCallCount: number;
    terminalReason: string;
    model: string;
    provider: string;
    compactionApplied: boolean;
  };
}

interface ModelCallEvent {
  type: 'model_call';
  timestamp: number;
  metadata: {
    provider: string;
    model: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    statusCode: number;
    isRetry: boolean;
    isFallback: boolean;
    executionContext: string;
  };
}
```

### 2. PII-Safe Metadata

Enforce at the type level that analytics metadata never contains PII:

```typescript
/**
 * Metadata verified to not contain user content, PII, or file paths.
 * Only numeric metrics, enum values, and system-generated identifiers.
 */
type SafeMetadata = {
  [key: string]: string | number | boolean | null;
};

function logMetric(event: MetricEvent): void {
  // Validate metadata is safe
  // Buffer for batch export
  // Export to configured sinks
}
```

What should NEVER appear in analytics:
- Fan message content
- Creator system prompts or personality text
- Tool results containing user data
- File paths or URLs from conversations
- API keys or credentials

What IS safe:
- Token counts, latencies, error codes
- Model names, tool names, provider names
- Conversation IDs, creator IDs (if hashed)
- Counts, rates, percentages

### 3. Metrics Aggregation

Aggregate raw events into operational metrics:

```typescript
interface OperationalMetrics {
  // Throughput
  turnsPerMinute: number;
  conversationsActive: number;
  requestsQueued: number;

  // Latency
  p50TurnLatencyMs: number;
  p95TurnLatencyMs: number;
  p99TurnLatencyMs: number;
  avgModelCallLatencyMs: number;

  // Errors
  errorRate: number;  // errors / total turns
  modelErrorRate: number;
  toolErrorRate: number;
  quotaExceededRate: number;

  // Cost
  totalCostUsdLast1h: number;
  avgCostPerTurnUsd: number;
  avgCostPerConversationUsd: number;

  // Model
  fallbackRate: number;  // how often fallback model is used
  compactionRate: number;  // how often compaction triggers

  // Guardrails
  inputBlockRate: number;
  outputViolationRate: number;
  jailbreakAttemptRate: number;
}
```

### 4. Performance Profiling

Built-in timing for critical runtime operations:

```typescript
class PerformanceProfiler {
  private checkpoints: Map<string, number> = new Map();

  checkpoint(name: string): void {
    this.checkpoints.set(name, performance.now());
  }

  measure(name: string, startCheckpoint: string): number {
    const start = this.checkpoints.get(startCheckpoint);
    if (!start) return -1;
    return performance.now() - start;
  }

  report(): ProfileReport {
    return {
      checkpoints: Object.fromEntries(this.checkpoints),
      // Computed durations between checkpoints
    };
  }
}

// Usage in TurnExecutor:
profiler.checkpoint('turn_start');
profiler.checkpoint('prompt_projection_done');
profiler.checkpoint('model_call_start');
// ... model call ...
profiler.checkpoint('model_call_done');
profiler.checkpoint('tool_execution_start');
// ... tools ...
profiler.checkpoint('tool_execution_done');
profiler.checkpoint('turn_done');

// Result: breakdown of where time is spent
// {
//   prompt_projection: 12ms,
//   model_call: 1450ms,
//   tool_execution: 230ms,
//   overhead: 8ms,
//   total: 1700ms
// }
```

### 5. In-Memory Error Ring Buffer

Keep recent errors in memory for diagnostics without writing to disk:

```typescript
class ErrorBuffer {
  private buffer: ErrorEntry[] = [];
  private readonly maxSize = 100;

  capture(error: Error, context: Record<string, unknown>): void {
    this.buffer.push({
      timestamp: Date.now(),
      message: error.message,
      stack: error.stack,
      context,
    });
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getRecent(count = 10): ErrorEntry[] {
    return this.buffer.slice(-count);
  }

  // Exposed via health endpoint for debugging
  toJSON(): object {
    return {
      count: this.buffer.length,
      recent: this.getRecent(5).map(e => ({
        timestamp: e.timestamp,
        message: e.message,
        // No stack in health endpoint — only in debug mode
      })),
    };
  }
}
```

### 6. Metrics Export

Pluggable export to monitoring systems:

```typescript
interface MetricsSink {
  name: string;
  emit(event: MetricEvent): void;
  flush(): Promise<void>;
}

// Built-in sinks:
class StdoutMetricsSink implements MetricsSink { ... }
class JsonFileMetricsSink implements MetricsSink { ... }

// Future sinks (not in scope now):
// class DatadogMetricsSink implements MetricsSink { ... }
// class PrometheusMetricsSink implements MetricsSink { ... }
```

Initial implementation: structured JSON logs to stdout + optional file. Monitoring systems can ingest structured logs.

### 7. Health Endpoint Enhancement

Extend the existing `/health` endpoint with operational metrics:

```typescript
// GET /health response
{
  "status": "healthy",
  "uptime_seconds": 3600,
  "metrics": {
    "active_conversations": 12,
    "turns_last_5min": 45,
    "avg_turn_latency_ms": 1200,
    "error_rate_last_5min": 0.02,
    "model_fallback_active": false
  },
  "recent_errors": [
    { "timestamp": 1712764800, "message": "Model API timeout" }
  ]
}
```

## What NOT To Borrow

- **Datadog/third-party SDK integration** — start with structured logs, add integrations later
- **Analytics opt-out UI** — no user-facing analytics controls needed
- **Session replay** — track 05 (Transcripts) handles this
- **Startup profiling for module load** — not a bottleneck for an HTTP service
- **React-specific profiling** — no UI to profile

## Implementation

### Step 1: Event Types and Logger

- Add `src/metrics/types.ts` — typed metric events
- Add `src/metrics/MetricsLogger.ts` — core logging function with PII validation
- Add `src/metrics/sinks/StdoutSink.ts` — structured JSON log output

### Step 2: Turn and Model Call Instrumentation

- Add timing instrumentation to `TurnExecutor.ts`
- Emit `turn_completed` and `model_call` events with latency breakdown
- Wire token usage from API responses into events

### Step 3: Performance Profiler

- Add `src/metrics/PerformanceProfiler.ts`
- Integrate checkpoint calls into turn execution path
- Include profiler report in turn transcript (track 05)

### Step 4: Error Buffer

- Add `src/metrics/ErrorBuffer.ts` — ring buffer for recent errors
- Capture errors from model calls, tool execution, config loading
- Expose via enhanced `/health` endpoint

### Step 5: Metrics Aggregation

- Add `src/metrics/MetricsAggregator.ts`
- Rolling window aggregation (1min, 5min, 1hr)
- Expose via `/health` or dedicated `/metrics` endpoint

### Step 6: Operational Dashboard Data (optional)

- Aggregate metrics into dashboard-ready format
- Per-creator usage breakdown
- Error rate trends
- Model performance comparison

## Config Schema Extension

```yaml
metrics:
  enabled: true
  sinks:
    - type: stdout
      level: info  # info | debug | trace
    - type: file
      path: /var/log/digitalme-agent/metrics.jsonl
      rotation: daily
  profiling:
    enabled: true
    include_in_transcript: true
  error_buffer:
    max_size: 100
    expose_in_health: true
```

## Dependencies

- Track 07 (Events) — internal events feed into metrics logger
- Track 05 (Transcripts) — profiler reports included in transcripts
- Track 11 (Usage) — cost metrics derived from usage tracking
- Track 10 (Guardrails) — guardrail metrics (block rates, violation rates)

## Success Criteria

- Every turn produces structured metric events (not console.log)
- Turn latency is broken down by phase (prompt, model, tools, overhead)
- Error rates and model fallback rates are visible in health endpoint
- No PII appears in any metric event (enforced at type level)
- Recent errors are available for diagnostics without log diving
- Metrics format is ingestible by standard monitoring tools (structured JSON)
- Adding a new metric requires adding one event type and one emit call — not plumbing
