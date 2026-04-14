# Track 15: Fast Model Routing — Tasks

## Step 1: Config and Schema Cleanup

- [ ] Add `fast_model: modelSchema.optional()` to `agentConfigSchema`
- [ ] Remove `routing.task_models` from schema
- [ ] Remove `context.summary.model` from schema
- [ ] Remove `context.session_memory.extraction_model` from schema
- [ ] Keep `routing.health` intact
- [ ] Update `config.example.yaml` with a `fast_model` section and wording that distinguishes:
  - [ ] `model` = primary
  - [ ] `fallback_model` = provider health fallback
  - [ ] `fast_model` = helper-model class
- [ ] Update test fixtures and inline test configs

## Step 2: Fix The Execution Abstraction

- [ ] Add a safe internal execution override that can carry a full model selection
- [ ] Do **not** rely on `ExecutionOptions.model` string alone for cross-provider routing
- [ ] Ensure `TurnExecutor` can instantiate the correct client for an explicitly selected internal model config
- [ ] Add tests proving a helper task can use a different provider/config correctly

## Step 3: Simplify Router Terminology

- [ ] Simplify `ModelTask` to `'primary' | 'fallback' | 'fast'`
- [ ] Update `ModelRouter.resolve()` to handle `'fast'`
- [ ] Remove summary/extraction/forked task-specific routing cases
- [ ] Update tests to reflect the new task model vocabulary
- [ ] Explicitly verify router auto-enable behavior after removing `routing.task_models`

## Step 4: Fix Cost-Aware Downgrade

- [ ] In `TurnExecutor`, change quota-pressure downgrade preference to:
  - [ ] `config.fast_model`
  - [ ] else `config.fallback_model`
  - [ ] else no downgrade
- [ ] Make sure the downgrade uses the correct client/provider, not only a swapped model string
- [ ] Keep health-failure fallback behavior unchanged
- [ ] Add tests:
  - [ ] downgrade uses `fast_model` when configured
  - [ ] downgrade falls back to `fallback_model` when no `fast_model`
  - [ ] downgrade does nothing when neither is configured

## Step 5: Keep Claudy-Aligned Non-Goals Explicit

- [ ] Do **not** switch session memory extraction to `fast_model` in this track
- [ ] Do **not** claim summary/compaction routing changes unless a live summary path is wired
- [ ] Do **not** treat all forked/background work as `fast`

## Step 6: Tests and Verification

- [ ] `npx tsc --noEmit`
- [ ] Run model-router tests
- [ ] Run turn-executor recovery / downgrade tests
- [ ] Run any tests touched by schema fixture changes
- [ ] Add regression tests for the chosen internal execution override path

## Done Criteria

- [ ] `fast_model` is introduced as a separate helper-model concept
- [ ] `fallback_model` is reserved for provider-health fallback semantics
- [ ] Cost-aware downgrade prefers `fast_model`
- [ ] Helper-task execution can select a full model config safely
- [ ] Session memory extraction remains on the primary model in this track
- [ ] Dead config fields are removed
- [ ] Docs no longer claim that all background tasks should use the fast model
- [ ] Tests cover the new routing and downgrade behavior
