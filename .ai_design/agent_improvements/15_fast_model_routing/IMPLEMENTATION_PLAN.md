# Track 15: Fast Model Routing

## Goal

Add a dedicated `fast_model` config for cheap/fast helper tasks, separate from `fallback_model`:

- `fallback_model` remains a same-tier alternative for provider health failures
- `fast_model` is an optional lower-cost model for explicitly chosen lightweight internal helpers

The design should follow Claudy's current pattern:

- clearly distinguish "small fast model" from "main / parent model"
- use the cheap fast model only for some helper tasks
- keep the main / parent model for quality-sensitive or cache-sharing work

## Problem

The current design conflates two distinct concepts into `fallback_model`:

| Concept | Purpose | Example model |
|---------|---------|---------------|
| **Fallback** | Same-tier alternative when the primary provider is unhealthy | `claude-sonnet-4` when primary is `gpt-5.4` |
| **Fast/cheap** | Lower-cost helper model for bounded internal tasks | `gpt-5.4-mini`, `haiku-4.5` |

Today, `CostAwareRouter` signals `useFallbackModel: true` under quota pressure, and `TurnExecutor` switches only the model name to `fallback_model`. That is the wrong intent: quota pressure should prefer a cheaper model, not a same-tier failover model.

Separately, the current codebase has some unused task-specific routing config that should either be wired honestly or removed.

## Claudy Reference

Claudy (`/home/irichard/dev/study/claudy/src`) does have a clear cheap-fast concept:

- `getSmallFastModel()` returns `process.env.ANTHROPIC_SMALL_FAST_MODEL` or the default Haiku model
- it is used for lightweight helper tasks such as away summaries, prompt hooks, title generation, helper parsing/classification, and token-estimation helpers
- subagents default to inheriting the parent model
- session memory extraction and compaction-style work run via forked-agent paths that preserve the parent's model / cache-safe request shape

Key implication:

> Claudy does **not** use the cheap fast model for all background work.

It uses it for helper-style tasks, while keeping the primary / parent model for work where quality, continuity, or prompt-cache sharing matters.

## Current State In DigitalMe Agent

### What exists and works

- `config.model` is the primary model for user-facing turns
- `config.fallback_model` is used for health failure recovery
- `ModelRouter.resolve('primary')` exists for health-aware main-turn routing
- `callModelWithRecovery()` retries and falls back on repeated provider overload
- `CostAwareRouter` can signal downgrade intent with `useFallbackModel`

### What exists but is misleading or not wired

- `routing.task_models.summary` exists in schema and router, but no active turn path uses `ConversationSummaryBuilder`
- `routing.task_models.extraction` exists, but `SessionMemoryHook` does not resolve a task-specific client
- `routing.task_models.forked` exists, but `ForkedAgent` does not route through task type
- `context.summary.model` exists in schema and is not read
- `context.session_memory.extraction_model` exists in schema and is not read

### Important architectural constraint

Today, `ExecutionOptions.model` is only a string model name. It does **not** carry provider credentials or a full `ModelConfig`.

That means:

- passing `model: "gpt-5.4-mini"` to a fork only works safely if the primary client/provider can actually serve that model
- it is **not** a correct way to select a different provider config
- cost-aware downgrade already has this weakness today

So any fast-model rollout must first support selecting a full model config, not just a model name string.

## Design Principles

1. **Match Claudy's split**
   `fast_model` is for lightweight helper tasks only; primary model remains the default for quality-sensitive internal work.

2. **Keep fallback semantics clean**
   `fallback_model` is only for provider health failures, not cost optimization.

3. **Only expose config that is real**
   Remove dead per-task model knobs that are not actually honored.

4. **Do the prerequisite refactor first**
   Background execution must be able to select a full `ModelConfig`, not only a model name.

## Target Design

### New config field

```yaml
model:
  provider: openai
  name: gpt-5.4
  api_key: ${MODEL_API_KEY}
  max_output_tokens: 8192

fallback_model:
  provider: anthropic
  name: claude-sonnet-4-20250514
  api_key: ${FALLBACK_API_KEY}
  max_output_tokens: 8192

fast_model:
  provider: openai
  name: gpt-5.4-mini
  api_key: ${MODEL_API_KEY}
  max_output_tokens: 4096
```

### Model classes

#### Primary model

Use `config.model` for:

- main user-facing turns
- session memory extraction
- compaction / continuity-sensitive summarization
- general forked-agent work unless a specific helper path says otherwise

#### Fast model

Use `config.fast_model` only for explicitly enumerated helper tasks, for example:

- short helper summaries / recaps
- title / label generation
- hook evaluation
- lightweight parsing / classification helpers
- token-estimation or similar bounded internal inference

If no `fast_model` is configured, those helper tasks fall back to `config.model`.

### Resolution order

#### Main user-facing turn

1. `config.model`
2. if primary provider unhealthy -> `config.fallback_model`
3. if all unhealthy -> `config.model`

#### Helper task using fast model class

1. `config.fast_model` if configured
2. otherwise `config.model`

Health fallback for helper tasks is optional implementation detail, but the first release should prefer correctness and simplicity over broad routing behavior.

#### Cost-aware downgrade

1. `config.fast_model` if configured
2. otherwise preserve current legacy behavior with `config.fallback_model`
3. otherwise remain on `config.model`

This keeps current installs working while separating the concepts cleanly.

## Scope For This Track

### In scope

1. Add `fast_model` to config and example config
2. Fix cost-aware downgrade so it can use `fast_model`
3. Add a safe mechanism for background/helper paths to choose a full `ModelConfig`
4. Remove dead config fields that are not wired

### Not in scope

1. Converting all forked/background work to `fast_model`
2. Moving session memory extraction to `fast_model`
3. Moving compaction / reactive compaction to `fast_model`
4. Re-activating unused summary-based compaction paths

Those would be separate design decisions, and for Claudy-alignment the default answer should stay "use the primary model."

## Required Prerequisite Refactor

Before wiring any helper task to `fast_model`, add a way for internal executions to select a full model configuration.

Acceptable options:

- add `ExecutionOptions.modelConfig?: ModelConfig`
- or add `ExecutionOptions.modelTask?: 'primary' | 'fallback' | 'fast'`

Requirements:

- cross-provider fast models must work correctly
- internal forks must not rely on string model names alone
- the chosen provider/model must be reflected in the instantiated client, not just in telemetry text

## Changes To ModelRouter

Simplify routing terminology:

```typescript
type ModelTask = 'primary' | 'fallback' | 'fast';
```

`fast` means "helper-model class", not "all forked work".

`ModelRouter` may expose:

- `resolve('primary')`
- `resolve('fallback')`
- `resolve('fast')`

But it should no longer imply that summary, extraction, and generic forks are all routed independently. Those task names do not reflect the real code paths today.

## Changes To TurnExecutor

### Cost-aware downgrade

Change the downgrade preference from:

- current: `fallback_model`

to:

- `fast_model`
- else `fallback_model`
- else no downgrade

This is the concrete place where the fallback-vs-fast distinction matters immediately.

### Execution option support

Teach the execution path to honor a full model selection for internal/helper work.

The implementation must ensure that:

- a fast-model helper call creates the correct client for the selected provider
- forks and helper calls do not accidentally use the primary provider with only a swapped model name

## Changes To SessionMemoryHook

No routing change in this track.

Keep session memory extraction on the primary model for now to stay aligned with Claudy's pattern:

- session memory is continuity-sensitive
- forked execution currently inherits the main execution path
- moving it to `fast_model` would be a deliberate product tradeoff, not a Claudy-aligned default

The only acceptable change here would be future support for an explicit full-config override, but this track should not switch extraction to the fast model.

## Changes To Conversation Summary / Compaction

No routing change in this track.

Reason:

- `ConversationSummaryBuilder` exists, but the active `TurnExecutor` reactive-overflow path currently uses deterministic `tryReactiveCompact()` instead
- the summary-builder path is not currently a live integration point for turn execution

So this track should not claim summary routing benefits that are not actually reachable.

## Config Cleanup

Remove the dead config fields that are not truly honored:

- `routing.task_models`
- `context.summary.model`
- `context.session_memory.extraction_model`

Keep:

- `routing.health`

Important note:

Removing `routing.task_models` changes how `TurnExecutor` decides whether to auto-enable router behavior. The implementation and tests must account for that explicitly.

## Files Expected To Change

- `src/config/schema.ts`
  add `fast_model`, remove dead task-model config, remove dead summary/extraction model fields

- `src/models/types.ts`
  simplify `ModelTask` to `primary | fallback | fast`

- `src/models/ModelRouter.ts`
  replace summary/extraction/forked task routing with `fast`

- `src/agent/types.ts`
  add a safe internal execution override that can carry a full model selection

- `src/agent/TurnExecutor.ts`
  fix cost-aware downgrade and honor the new full-config override path

- `config.example.yaml`
  document `fast_model`

- tests for the above

## Success Criteria

1. `fast_model` exists as a separate config concept from `fallback_model`
2. Cost-aware downgrade prefers `fast_model` instead of abusing `fallback_model`
3. Internal helper execution can select a full model config safely across providers
4. Session memory extraction remains on the primary model in this track
5. Compaction / summary routing claims match the actual live code paths
6. Dead config fields are removed
7. Existing behavior is unchanged when `fast_model` is not configured
8. Tests cover downgrade and model-selection correctness
