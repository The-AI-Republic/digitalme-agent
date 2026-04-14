# Track 15: Fast Model Routing — Tasks

## Step 1: Config Schema Update

- [ ] Add `fast_model: modelSchema.optional()` to `agentConfigSchema`
- [ ] Remove `routing.task_models` (summary, extraction, forked) from schema
- [ ] Remove `context.summary.model` from schema
- [ ] Remove `context.session_memory.extraction_model` from schema
- [ ] Keep `routing.health` intact
- [ ] Update `config.example.yaml` with `fast_model` section
- [ ] Update test fixtures in `src/test/fixtures.ts`
- [ ] Update inline test configs across test files
- [ ] Verify: `npx tsc --noEmit` passes, all existing tests pass

## Step 2: Simplify ModelTask and ModelRouter

- [ ] Simplify `ModelTask` in `src/models/types.ts` to `'primary' | 'fallback' | 'fast'`
- [ ] Update `ModelRouter.resolve()` to handle `'fast'` task
- [ ] Update `ModelRouter.getTaskModel()`: remove summary/extraction/forked cases, add fast
- [ ] Update `ModelRouter` constructor: remove `task_models` dependency from health tracker init
- [ ] Update ModelRouter tests: remove summary/extraction/forked test cases, add fast model tests
- [ ] Verify: all ModelRouter tests pass

## Step 3: Wire Fast Model into ConversationSummaryBuilder

- [ ] Resolve fast model client where `ConversationSummaryBuilder` is instantiated
- [ ] If `config.fast_model` exists, create client via `modelClientFactory.createFromConfig(config.fast_model)`
- [ ] Otherwise fall back to primary client
- [ ] Add test: summary uses fast model client when configured
- [ ] Add test: summary uses primary client when fast_model not configured
- [ ] Verify: reactive compact tests pass

## Step 4: Wire Fast Model into SessionMemoryHook

- [ ] Pass `config.fast_model?.name` as `model` in `ExecutionOptions` when launching forked agent
- [ ] If fast_model not configured, omit model (preserves current behavior — uses primary)
- [ ] Add test: session memory extraction uses fast model when configured
- [ ] Add test: session memory extraction uses primary when fast_model not configured
- [ ] Verify: session memory tests pass

## Step 5: Fix Cost-Aware Downgrade

- [ ] In `TurnExecutor`, change cost-aware downgrade to prefer `fast_model` over `fallback_model`
- [ ] Resolution: `config.fast_model ?? config.fallback_model`
- [ ] Update recovery event detail to distinguish `cost_aware_downgrade` (fast) from `fallback_health`
- [ ] Add test: cost-aware downgrade uses fast_model when configured
- [ ] Add test: cost-aware downgrade falls back to fallback_model when no fast_model
- [ ] Add test: cost-aware downgrade does nothing when neither configured
- [ ] Verify: TurnExecutor recovery tests pass

## Step 6: Clean Up Dead Code

- [ ] Remove `hasTaskSpecificRouting()` from TurnExecutor (no longer needed — fast model uses different path)
- [ ] Remove any references to `routing.task_models` in non-test code
- [ ] Remove `RoutingReason` values tied to task-specific routing if unused
- [ ] Verify: `npx tsc --noEmit` passes, full test suite passes

## Step 7: Integration Tests

- [ ] Add integration test: full turn with fast_model configured, verify summary uses fast client
- [ ] Add integration test: health fallback still uses fallback_model (not fast_model)
- [ ] Add integration test: cost-aware downgrade uses fast_model
- [ ] Add integration test: no fast_model configured, everything falls back to primary
- [ ] Verify: all tests pass, TypeScript compiles cleanly

## Done Criteria

- [ ] `fast_model` config field works end-to-end
- [ ] Summarization uses fast model when configured
- [ ] Session memory extraction uses fast model when configured
- [ ] Cost-aware downgrade uses fast model (not fallback)
- [ ] Fallback model is only used for provider health failures
- [ ] Dead config fields removed (task_models, summary.model, extraction_model)
- [ ] All existing tests pass (with updates for schema changes)
- [ ] New tests cover fast model routing paths
- [ ] TypeScript compiles cleanly
