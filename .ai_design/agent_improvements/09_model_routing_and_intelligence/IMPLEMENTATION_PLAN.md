# 09 — Model Routing and Intelligence

## What This Track Covers

Context-based model routing: use the primary model for fan-facing conversation, a cheap model for all background work, and automatic fallback on provider failures. Follows Claudy's proven pattern of routing by **execution context**, not by message complexity.

## Why This Is Not Covered by Existing Tracks

Track 04 (Recovery and Continuation) implements 529 fallback as a retry mechanism inside `TurnExecutor.callModelWithRecovery()`. This track extracts model routing into a dedicated subsystem so that background work (memory extraction, compaction, future tool summaries) can use cheaper models independently of the main conversation path.

## How Claudy Actually Routes Models

After deep-diving the Claudy source (`/home/irichard/dev/study/claudy/src`), the real pattern is simpler than originally documented:

### Two-tier model system

| Tier | Resolution | Used for |
|------|-----------|----------|
| **Main loop** | `getMainLoopModel()` — user subscription tier determines default (Opus for Max, Sonnet for Pro) | Fan-facing conversation, streaming responses |
| **Small/fast** | `getSmallFastModel()` → Haiku 4.5 | Everything else (non-interactive, non-streaming) |

### What uses Haiku (cheap model) — all via `queryHaiku()` helper

- Tool use summaries (30-char labels for mobile UI)
- Session title / rename generation
- Web fetch content extraction
- Shell command prefix parsing
- MCP datetime parsing
- Agent hooks
- Away summaries

Key properties of `queryHaiku()`:
- Forces `getSmallFastModel()` (Haiku)
- Disables thinking (`thinkingConfig: { type: 'disabled' }`)
- Non-streaming only
- **Fails gracefully** — errors don't affect the main conversation

### Subagent model routing

- `'inherit'` (default) — subagent uses parent's exact model
- `'haiku'` — cheap (e.g., Explore agent for external users)
- `'sonnet'` / `'opus'` — explicit tier, matched to parent's provider/region

### 529 auto-downgrade

- 3 consecutive 529 errors → throw `FallbackTriggeredError` → switch to fallback model
- Non-foreground sources (summaries, titles) **don't retry** — fail silently to avoid amplifying load
- Fast mode: on 429/529, enters cooldown and retries without fast mode

### What Claudy does NOT do

- **No per-message complexity classification** — "hello" and complex questions use the same model
- **No automatic effort adjustment based on message content** — effort is user-set via `/effort` command or hardcoded per subscription tier
- **No model switching mid-conversation** based on message analysis

## Current DigitalMe Agent Situation

### Already built (better than originally documented)

- **`src/models/ModelClientFactory.ts`** — factory pattern supporting OpenAI, Anthropic, xAI, Groq, Google AI, Fireworks, Together
- **`src/agent/TurnExecutor.ts:callModelWithRecovery()`** — already has 529 fallback with 3-consecutive-error threshold (matches Claudy's pattern)
- **`config/schema.ts`** — `fallback_model` field already in schema and wired into TurnExecutor
- **`config/schema.ts`** — `extraction_model` and `summary.model` fields already defined in schema

### The gap

- **`extraction_model` is never read** — SessionMemoryHook always uses the primary model client
- **`summary.model` is never read** — ConversationSummaryBuilder takes whatever client is passed to it
- **No `createBackgroundClient()` helper** — no equivalent of Claudy's `queryHaiku()` pattern
- **No graceful failure for background work** — if memory extraction fails, there's no silent fallback

## What To Borrow

### 1. Background Model Client (like Claudy's `queryHaiku()`)

A dedicated helper that creates a cheap model client for non-fan-facing work:

```typescript
// src/models/ModelClientFactory.ts — extend existing factory

/**
 * Create a client for background work (memory extraction, compaction, summaries).
 * Uses the configured background model, falling back to primary if not configured.
 * Equivalent to Claudy's queryHaiku() pattern.
 */
createBackgroundClient(): ModelClient {
  const bgConfig = this.config.background_model ?? this.config.model;
  return this.createFromConfig(bgConfig);
}
```

Key properties (matching Claudy):
- Non-streaming
- Thinking disabled (cheaper, faster)
- **Fails gracefully** — background work errors are logged, never propagated to fan conversation
- Uses `background_model` from creator config, defaults to primary if not set

### 2. Context-Based Routing (execution context, not message content)

Route by **who is calling**, not **what the message says**:

| Context | Model | Rationale |
|---------|-------|-----------|
| Fan conversation (main loop) | `config.model` (primary) | Best quality for user-facing output |
| Session memory extraction | `config.background_model` or primary | Internal, non-user-facing |
| Reactive compaction summary | `config.background_model` or primary | Emergency recovery, speed matters |
| Future: tool-use summaries | `config.background_model` or primary | Short structured output |

This is exactly how Claudy does it — no classifier, no heuristics, just a switch on execution context.

### 3. Wire Up Existing Schema Fields

The schema already defines `extraction_model` and `summary.model` but they're never read. Wire them:

- `SessionMemoryHook` → use `config.context.session_memory.extraction_model` to create a background client
- `ConversationSummaryBuilder` → use `config.context.summary.model` to create a background client
- Both fall back to primary model if the background field is not configured

### 4. Graceful Failure for Background Work

Following Claudy's pattern where `queryHaiku()` callsites all catch and swallow errors:

```typescript
// In SessionMemoryHook — wrap the forked agent call
try {
  await this.extractMemory(messages, backgroundClient);
} catch (error) {
  this.logger.warn('Session memory extraction failed, skipping', { error });
  // Don't propagate — fan conversation is unaffected
}
```

Non-foreground operations should never crash the main conversation.

## What NOT To Borrow

- **Effort-level classification of messages** — Claudy doesn't do this; the `/effort` command is user-initiated. Automatic message classification ("is this a simple greeting?") is over-engineering and error-prone
- **Interactive model selection UI** — fans don't choose models
- **Per-session model override** — creators configure, fans don't choose
- **Model capability detection system** — premature; check capabilities if/when we add vision or thinking support
- **Prompt caching eligibility tracking** — provider-specific optimization, premature

## Implementation

### Step 1: Extend `ModelClientFactory` with `createBackgroundClient()`

- Add `background_model` to creator config schema (alongside existing `model` and `fallback_model`)
- Add `createBackgroundClient()` method that uses `background_model` config, falling back to primary
- Background client should disable thinking and use lower `max_output_tokens`

### Step 2: Wire `SessionMemoryHook` to use background client

- Read `config.context.session_memory.extraction_model` (already in schema, never read)
- Pass background client to the forked agent instead of primary client
- Wrap in try/catch with graceful failure (log and skip)

### Step 3: Wire `ConversationSummaryBuilder` to use background client

- Read `config.context.summary.model` (already in schema, never read)
- When ReactiveCompact instantiates ConversationSummaryBuilder, pass background client
- Wrap in try/catch with graceful failure

### Step 4: Consolidate config into `background_model`

- Deprecate separate `extraction_model` and `summary.model` fields
- Introduce single `background_model` in top-level config (like Claudy's single `getSmallFastModel()`)
- Keep backward compat: if `extraction_model` is set, use it; otherwise fall back to `background_model`; otherwise fall back to primary

## Config Schema Extension

```yaml
# Creator config
model:
  provider: anthropic
  name: claude-sonnet-4-6
  api_key: ${ANTHROPIC_API_KEY}

background_model:           # NEW — cheap model for non-fan-facing work
  provider: anthropic
  name: claude-haiku-4-5-20251001
  api_key: ${ANTHROPIC_API_KEY}

fallback_model:              # EXISTING — used on 529 errors (already wired)
  provider: openai
  name: gpt-4o
  api_key: ${OPENAI_API_KEY}
```

If `background_model` is omitted, all background work uses the primary model (safe default, no behavior change).

## Dependencies

- Track 04 (Recovery) — 529 fallback already implemented in TurnExecutor, no changes needed
- Track 07 (Events) — emit model switch events when background model is used
- Track 08 (Forked Agents) — forked agents should accept a model client parameter

## Success Criteria

- Background work (memory extraction, compaction summaries) uses `background_model` when configured
- Background work fails gracefully — errors are logged, never propagated to fan conversation
- Existing `extraction_model` and `summary.model` schema fields are actually read and used
- No behavior change when `background_model` is not configured (safe default)
- Cost reduction is measurable: background work should cost ≤50% of primary model cost when background_model is Haiku
