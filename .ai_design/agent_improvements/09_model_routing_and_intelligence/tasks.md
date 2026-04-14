# Track 09: Model Routing and Intelligence — Tasks

## Step 1: Routing Types and Interfaces [DONE]

- [x] Create `src/models/types.ts`
- [x] Define `ModelTask` type union: primary, fallback, summary, extraction, forked
- [x] Define `RoutingDecision` interface with modelConfig, reason, task
- [x] Define `RoutingReason` type union
- [x] Define `ProviderHealthSnapshot` interface
- [x] Define `HealthEvent` interface
- [x] Define `HealthTrackerConfig` interface with defaults
- [x] Define `ModelCapability` interface (for future expansion)
- [x] Verify: `npx tsc --noEmit` passes

## Step 2: Provider Health Tracker [DONE]

- [x] Create `src/models/ProviderHealthTracker.ts`
- [x] Implement per-provider sliding window of `HealthEvent` records
- [x] Implement failure rate computation
- [x] Implement circuit breaker: open when failureRate >= threshold
- [x] Implement half-open state: allow probe after recoveryAfterSeconds
- [x] Implement circuit close on success
- [x] Implement average latency from successful events only
- [x] Implement `getSnapshot()` for single provider
- [x] Implement `getAllSnapshots()` for all tracked providers
- [x] Implement `reset()` to clear all state
- [x] Verify: unit tests pass

## Step 3: Model Router [DONE]

- [x] Create `src/models/ModelRouter.ts`
- [x] Implement `resolve(task: ModelTask): RoutingDecision`
- [x] Task resolution: check task-specific config first, then primary
- [x] Health-aware: route to fallback if resolved provider unhealthy
- [x] Implement `resolveClient(task)` with client caching
- [x] Implement `getOrCreateClient(modelConfig)` with cache by config key
- [x] Implement `recordSuccess()` and `recordFailure()` delegating to health tracker
- [x] Implement `getProviderHealth()`, `getAllProviderHealth()`, `isProviderHealthy()`
- [x] Implement `reset()` clearing both health and client cache
- [x] Verify: unit tests pass

## Step 4: Config Schema Update [DONE]

- [x] Add `routing` section to `agentConfigSchema` in `src/config/schema.ts`
- [x] Add `task_models` with optional summary, extraction, forked model configs
- [x] Add `health` with enabled, window_size, failure_threshold, recovery_after_seconds
- [x] Set sensible defaults (all optional, health enabled by default)
- [x] Update `config.example.yaml` with commented routing examples
- [x] Update test config in `src/test/fixtures.ts`
- [x] Update inline test configs in `server.integration.test.ts`, `HeartbeatService.test.ts`, `ModelClientFactory.test.ts`
- [x] Verify: `npx tsc --noEmit` passes, all existing tests pass

## Step 5: Factory Integration [DONE]

- [x] Add `getRouter()` to `ModelClientFactory`
- [x] Lazy-create router on first call
- [x] Cache router instance
- [x] Add `getRouter?()` to `IModelClientFactory` interface
- [x] Export `createClientFromModelConfig()` for direct use
- [x] Re-export routing types from factory module
- [x] Add factory tests: `createFromConfig`, `getRouter` singleton behavior
- [x] Verify: all tests pass

## Step 6: TurnExecutor Integration [DONE]

- [x] Add `modelRouter?: ModelRouter` to `TurnExecutorDeps`
- [x] Auto-create router from factory if not injected
- [x] Use `resolveClient('primary')` for initial model selection
- [x] Pass resolved provider to `callModelWithRecovery()`
- [x] Record success in `callModelWithRecovery()` after successful `generate()`
- [x] Record failure in `callModelWithRecovery()` after failed `generate()`
- [x] Use router's `getOrCreateClient()` for fallback client creation
- [x] Add `getRouter()` method to TurnExecutor for external access
- [x] Update prompt context to use resolved model name and provider
- [x] Verify: existing TurnExecutor tests still pass

## Step 7: Tests [DONE]

- [x] Create `src/models/ProviderHealthTracker.test.ts`
  - [x] New provider healthy by default
  - [x] Snapshot for unknown provider returns zeroes
  - [x] Records successes correctly
  - [x] Records failures correctly
  - [x] Average latency from successful events
  - [x] Average latency excludes failures
  - [x] Sliding window trims old events
  - [x] Circuit opens when failure rate exceeds threshold
  - [x] Circuit stays closed below threshold
  - [x] Circuit closes on success after being open
  - [x] Half-open state allows probe after recovery period
  - [x] Multiple providers tracked independently
  - [x] getAllSnapshots returns all providers
  - [x] Reset clears all data
  - [x] Single failure does not trip circuit
  - [x] Exactly at threshold trips circuit
- [x] Create `src/models/ModelRouter.test.ts`
  - [x] Resolves primary model for primary task
  - [x] Resolves fallback model for fallback task
  - [x] Falls back to primary when no task-specific model
  - [x] Resolves task-specific model from routing config
  - [x] Extraction and forked tasks fall back to primary
  - [x] resolveClient returns client and decision
  - [x] resolveClient caches clients
  - [x] Different configs get different clients
  - [x] Health-aware routing to fallback
  - [x] Uses primary when all providers unhealthy
  - [x] Health-aware routing for task-specific models
  - [x] recordSuccess/recordFailure update tracker
  - [x] getAllProviderHealth returns snapshots
  - [x] isProviderHealthy delegates correctly
  - [x] Reset clears health and cache
  - [x] getOrCreateClient caching and differentiation
  - [x] Without fallback, unhealthy primary still returns primary
  - [x] Provider recovers after success
- [x] Create `src/models/ModelRouter.integration.test.ts`
  - [x] TurnExecutor uses router to resolve primary model
  - [x] TurnExecutor records health events on success
  - [x] TurnExecutor records health events on failure
  - [x] TurnExecutor getRouter() returns router instance
  - [x] TurnExecutor works without router (backwards compatible)
  - [x] Health-aware routing with fallback model config
- [x] Update `src/models/ModelClientFactory.test.ts`
  - [x] createFromConfig creates fresh client
  - [x] getRouter returns a ModelRouter
  - [x] getRouter returns same instance

## Done Criteria

- [x] All 388 tests pass (341 existing + 47 new)
- [x] TypeScript compiles cleanly
- [x] Primary model resolution considers provider health
- [x] Task-specific models configurable via routing.task_models
- [x] Circuit breaker pattern with sliding window
- [x] Client caching by config key
- [x] Health data inspectable via getProviderHealth()
- [x] Backwards compatible — no behavior change without explicit config
