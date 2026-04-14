# Track 15: Fast Model Routing

## Goal

Add a dedicated `fast_model` config for cheap/fast background tasks, separate from `fallback_model` (which is a same-tier alternative provider for health failures). Wire it into all internal tasks that don't need the primary model's full quality.

## Problem

The current design conflates two distinct concepts into `fallback_model`:

| Concept | Purpose | Example model |
|---------|---------|---------------|
| **Fallback** | Same-tier alternative when primary provider is down | claude-sonnet-4 (when primary is gpt-5.4) |
| **Fast/cheap** | Low-cost model for background tasks that don't face the user | gpt-5.4-mini, haiku-4.5 |

Today, `CostAwareRouter` signals `useFallbackModel: true` under quota pressure, which switches to `fallback_model` — but a fallback model is typically equally expensive (it's from a different provider, not a cheaper tier). The cost-aware downgrade should use a cheap model, not the health fallback.

Additionally, several internal tasks (summarization, session memory extraction) always use the primary model, wasting tokens on work the user never sees.

## Reference: How Claudy Does It

Claudy (`/home/irichard/dev/study/claudy/src`) uses a simple `getSmallFastModel()` function:

- Returns `process.env.ANTHROPIC_SMALL_FAST_MODEL` or defaults to Haiku 4.5
- Used for: away summaries, token estimation, hooks/skills, web search fast path
- Compaction and memory extraction use the **parent's primary model** (quality matters there)
- No config file entry — it's a code-level default with env var override

Key insight: Claudy keeps it simple. One function, one default, one override mechanism.

## Current State

### What exists and works

- `config.model` — primary model, used for user-facing conversations ✅
- `config.fallback_model` — alternative provider for health failures ✅
- `ModelRouter.resolve('primary')` — health-aware primary routing ✅
- `callModelWithRecovery()` — retries + fallback on consecutive 529s ✅
- `CostAwareRouter` — quota evaluation with `useFallbackModel` signal ✅

### What exists but is NOT wired

- `routing.task_models.summary` — defined in schema and ModelRouter, but `ConversationSummaryBuilder` never uses it
- `routing.task_models.extraction` — defined in schema and ModelRouter, but `SessionMemoryHook` launches forked agent without passing a model
- `routing.task_models.forked` — defined in schema and ModelRouter, but `ForkedAgent` doesn't query by task type
- `context.summary.model` — string field in schema, never read
- `context.session_memory.extraction_model` — string field in schema, never read

### Internal tasks using primary model (wasteful)

| Task | File | Current model | Should use |
|------|------|---------------|------------|
| Conversation summary (reactive compact) | `ConversationSummaryBuilder.ts` | Primary | Fast model |
| Session memory extraction | `SessionMemoryHook.ts` → `ForkedAgent` | Primary | Fast model |
| Cost-aware downgrade | `TurnExecutor.ts:245-249` | `fallback_model` | Fast model |

### Internal tasks that don't call a model (no change needed)

| Task | File | Reason |
|------|------|--------|
| Microcompact | `Microcompact.ts` | Deterministic, no model call |
| Session memory compact | `SessionMemoryCompact.ts` | Reads from disk, no model call |
| Prompt projection | `prepareContextForModelCall.ts` | Token math, no model call |

## Target Design

### New config field

```yaml
model:
  provider: openai
  name: gpt-5.4
  api_key: ${MODEL_API_KEY}
  max_output_tokens: 8192

# Same-tier alternative for when primary provider is down
fallback_model:
  provider: anthropic
  name: claude-sonnet-4-20250514
  api_key: ${FALLBACK_API_KEY}
  max_output_tokens: 8192

# Cheap/fast model for background tasks (summaries, extraction, cost downgrade)
fast_model:
  provider: openai
  name: gpt-5.4-mini
  api_key: ${MODEL_API_KEY}
  max_output_tokens: 4096
```

### Resolution order

```
User-facing turn:
  1. config.model (primary)
  2. If primary unhealthy → config.fallback_model
  3. If all unhealthy → config.model anyway

Background task (summary, extraction):
  1. config.fast_model (if configured)
  2. config.model (fallback if no fast_model)

Cost-aware downgrade (quota pressure):
  1. config.fast_model (if configured)
  2. config.fallback_model (legacy behavior if no fast_model)
  3. config.model (if neither configured)
```

### Changes to ModelRouter

Add a new task type `'fast'` and update resolution:

```typescript
// New in ModelTask
type ModelTask = 'primary' | 'fallback' | 'fast';

// New resolution in getTaskModel()
case 'fast':
  return this.config.fast_model;
```

Remove `'summary'`, `'extraction'`, `'forked'` from `ModelTask` — they were never wired and the distinction is unnecessary. All background tasks use the fast model.

### Changes to TurnExecutor

**Cost-aware downgrade** — use fast_model instead of fallback_model:

```typescript
// Before (wrong — fallback is same-tier, not cheap)
if (decision.useFallbackModel && this.config.fallback_model) {
  modelName = this.config.fallback_model.name;
}

// After
if (decision.useFallbackModel) {
  const fastConfig = this.config.fast_model ?? this.config.fallback_model;
  if (fastConfig) {
    modelName = fastConfig.name;
  }
}
```

### Changes to ConversationSummaryBuilder

Resolve the fast model client at construction time:

```typescript
// In TurnExecutor constructor or where SummaryBuilder is created
const summaryClient = this.config.fast_model
  ? this.modelClientFactory.createFromConfig(this.config.fast_model)
  : this.modelClientFactory.createClient();

this.summaryBuilder = new ConversationSummaryBuilder(summaryClient, ...);
```

### Changes to SessionMemoryHook

Pass explicit model when launching forked agent:

```typescript
// In SessionMemoryHook
const extractionModel = this.config.fast_model?.name;
launchForkedAgent({
  ...existingOptions,
  model: extractionModel,  // Will fall back to primary if undefined
});
```

### Config schema changes

```typescript
// In agentConfigSchema
model: modelSchema,
fallback_model: modelSchema.optional(),
fast_model: modelSchema.optional(),  // NEW
```

### Cleanup: remove dead routing config

Remove from schema (never wired, replaced by fast_model):
- `routing.task_models` (summary, extraction, forked)
- `context.summary.model`
- `context.session_memory.extraction_model`

Keep:
- `routing.health` — actively used for provider health tracking

## Design Principles

1. **Simple** — One `fast_model` config, not per-task model configs that nobody uses
2. **Optional** — Everything works without `fast_model`; falls back to primary
3. **Honest** — Don't expose config that isn't wired
4. **Correct** — Fallback is for health; fast is for cost. Don't conflate them.

## Files Changed

### Modified
- `src/config/schema.ts` — Add `fast_model`, remove `routing.task_models`, remove `context.summary.model`, remove `context.session_memory.extraction_model`
- `src/models/types.ts` — Simplify `ModelTask` to `'primary' | 'fallback' | 'fast'`
- `src/models/ModelRouter.ts` — Add `'fast'` task resolution, remove summary/extraction/forked
- `src/agent/TurnExecutor.ts` — Cost-aware downgrade uses `fast_model`
- `src/agent/context/ConversationSummaryBuilder.ts` — Accept fast model client
- `src/agent/context/SessionMemoryHook.ts` — Pass fast model to forked agent
- `config.example.yaml` — Add `fast_model` section
- Test files for all of the above

### No new files

The existing `ModelRouter` and `ModelClientFactory` handle everything. No new abstractions needed.

## Success Criteria

1. `fast_model` config is respected for summarization and extraction
2. Cost-aware downgrade uses `fast_model`, not `fallback_model`
3. `fallback_model` is only used for provider health failures
4. Without `fast_model` configured, all behavior is identical to before
5. Dead config fields (`routing.task_models`, `context.summary.model`, `context.session_memory.extraction_model`) are removed
6. All existing tests pass; new tests cover fast model routing
