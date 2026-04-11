# 09 — Model Routing and Intelligence Tasks

## Step 1: Extend `ModelClientFactory` with `createBackgroundClient()`

- [ ] Add `background_model` (optional `modelSchema`) to creator config schema in `src/config/schema.ts`
- [ ] Add `createBackgroundClient()` to `ModelClientFactory` — uses `background_model`, falls back to primary
- [ ] Background client: disable thinking, use lower `max_output_tokens`
- [ ] Unit test: `createBackgroundClient()` returns background config when set, primary when not

## Step 2: Wire `SessionMemoryHook` to use background client

- [ ] Read existing `config.context.session_memory.extraction_model` field (already in schema, never read)
- [ ] Pass background client to forked agent in `SessionMemoryHook` instead of primary
- [ ] Wrap extraction in try/catch — log and skip on failure, never propagate to fan conversation
- [ ] Integration test: memory extraction uses background model when configured

## Step 3: Wire `ConversationSummaryBuilder` to use background client

- [ ] Read existing `config.context.summary.model` field (already in schema, never read)
- [ ] When `ReactiveCompact` instantiates `ConversationSummaryBuilder`, pass background client
- [ ] Wrap summarization in try/catch — log and skip on failure
- [ ] Integration test: compaction summary uses background model when configured

## Step 4: Consolidate config into `background_model`

- [ ] Add top-level `background_model` field to config schema
- [ ] Resolution order: specific field (`extraction_model`, `summary.model`) → `background_model` → primary
- [ ] Update config validation to warn if specific fields are set alongside `background_model`
- [ ] Update example creator configs with `background_model: claude-haiku-4-5-20251001`
