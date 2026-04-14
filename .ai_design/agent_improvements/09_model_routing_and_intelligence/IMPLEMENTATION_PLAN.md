# Track 09: Model Routing and Intelligence

## Goal

Add a unified model routing layer that selects the best model for each task type, tracks provider health with a circuit breaker, and enables task-specific model configuration.

## Current State

Before this track, the agent had:

- A `ModelClientFactory` with singleton client + `createFromConfig()`
- A `fallback_model` config field with recovery-triggered switching (Track 04)
- Separate config strings for summary and extraction models (`context.summary.model`, `context.session_memory.extraction_model`)
- Model metadata (context window, max output tokens) per model name

The routing was implicit: the primary model was always used unless a 529-triggered fallback occurred. There was no health tracking, no task-based routing, and no shared client cache.

## Target Design

### New Components

#### `src/models/types.ts` — Shared routing types

- `ModelTask` — Task types: `primary`, `fallback`, `summary`, `extraction`, `forked`
- `RoutingDecision` — The resolved model config + reason + task
- `RoutingReason` — Why a model was chosen (config, health, override)
- `ProviderHealthSnapshot` — Per-provider health data
- `HealthEvent` — Individual health tracking event
- `HealthTrackerConfig` — Circuit breaker configuration
- `ModelCapability` — Model capability profile (for future use)

#### `src/models/ProviderHealthTracker.ts` — Circuit breaker health tracker

Tracks provider health using a per-provider sliding window of recent request outcomes:

- Records success/failure events with latency
- Computes failure rate across the sliding window
- Circuit breaker pattern: opens when failure rate exceeds threshold
- Half-open state: allows a probe request after recovery period
- Closes circuit on first success after being open
- Average latency computation from successful events only

Configuration:
- `windowSize` (default: 20) — Events in the sliding window
- `failureThreshold` (default: 0.5) — Failure rate to trip circuit
- `recoveryAfterSeconds` (default: 60) — Probe delay after circuit opens

#### `src/models/ModelRouter.ts` — Central routing logic

Resolves the best model for a given task by consulting:

1. Task-specific model config (`routing.task_models.*`)
2. Primary model config (`config.model`)
3. Provider health — routes to fallback if resolved provider is unhealthy

Key behaviors:
- Caches clients by composite key (`provider:name:base_url`)
- `resolve(task)` returns a `RoutingDecision` without creating a client
- `resolveClient(task)` returns both client and decision
- `recordSuccess()` / `recordFailure()` feed the health tracker
- `getProviderHealth()` / `getAllProviderHealth()` for observability
- `reset()` clears health data and client cache

### Configuration Changes

Added `routing` section to `AgentConfig`:

```yaml
routing:
  task_models:
    summary:
      provider: openai
      name: gpt-4o-mini
      api_key: ${MODEL_API_KEY}
      max_output_tokens: 4096
    extraction:
      provider: openai
      name: gpt-4o-mini
      api_key: ${MODEL_API_KEY}
      max_output_tokens: 4096
    forked:
      provider: openai
      name: gpt-4o-mini
      api_key: ${MODEL_API_KEY}
      max_output_tokens: 4096
  health:
    enabled: true
    window_size: 20
    failure_threshold: 0.5
    recovery_after_seconds: 60
```

### Integration Points

#### `ModelClientFactory`
- Added `getRouter()` method that returns a lazily-created `ModelRouter`
- Exported `createClientFromModelConfig()` for direct use
- Re-exported routing types for convenience

#### `TurnExecutor`
- Accepts optional `ModelRouter` via `TurnExecutorDeps`
- Auto-creates router from factory's `getRouter()` if not injected
- Uses `resolveClient('primary')` for initial model selection
- Records health events after every model call (success or failure)
- Passes resolved provider to `callModelWithRecovery()` for accurate health tracking
- Uses router's `getOrCreateClient()` for fallback client creation when router is available
- Exposes `getRouter()` for external health inspection

### Backwards Compatibility

- All changes are additive — the routing section has sensible defaults
- Without a `routing` config, behavior is identical to before
- Without a `modelRouter` dep, TurnExecutor uses the factory directly
- Existing tests pass without modification
- The `fallback_model` recovery path (Track 04) is preserved and enhanced

## Design Principles

1. **Additive** — No existing behavior changes without explicit opt-in
2. **Health-aware** — Provider failures are tracked and influence routing
3. **Task-aware** — Different tasks can use different models
4. **Cached** — Clients are reused across resolveClient() calls
5. **Observable** — Health snapshots available for monitoring/debugging
6. **Bounded** — Circuit breaker prevents cascading failures

## Files Changed

### New
- `src/models/types.ts`
- `src/models/ProviderHealthTracker.ts`
- `src/models/ModelRouter.ts`
- `src/models/ProviderHealthTracker.test.ts`
- `src/models/ModelRouter.test.ts`
- `src/models/ModelRouter.integration.test.ts`

### Modified
- `src/config/schema.ts` — Added `routing` section
- `src/models/ModelClientFactory.ts` — Added `getRouter()`, exported `createClientFromModelConfig()`
- `src/agent/TurnExecutor.ts` — Router integration, health recording
- `src/test/fixtures.ts` — Added routing to test config
- `config.example.yaml` — Documented routing and fallback config
- Test configs in `server.integration.test.ts`, `HeartbeatService.test.ts`, `ModelClientFactory.test.ts`

## Success Criteria

1. Primary model resolution considers provider health
2. Task-specific models are configurable via `routing.task_models`
3. Provider health is tracked with sliding window + circuit breaker
4. Fallback routing triggers when primary provider is unhealthy
5. Client instances are cached and reused
6. Health data is inspectable via `getProviderHealth()`
7. All existing tests continue to pass
8. New tests cover routing logic, health tracking, and integration
