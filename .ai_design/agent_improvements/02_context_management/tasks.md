# Tasks: Context Management

Source: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

This track delivers bounded model-facing context for long-running conversations without
changing the platform's ownership of canonical chat history. It adds token pressure
assessment, tool-result persistence, microcompact, session memory, projection,
summarization, reactive recovery, and max-output recovery.

Dependencies:
- Track `DONE-08_forked_and_subagents` for forked agents and post-turn hooks.
- Track `03_tool_runtime` for file-read and Edit-style tools if session-memory extraction
  and persisted tool-result retrieval are to be fully model-accessible.

---

## Step 1: TokenBudget + ToolResultPersistence + Message metadata + Session cleanup

### Types and metadata

- [ ] Add `id?: string` to `src/models/ModelClient.ts` `Message`.
- [ ] Add `timestamp?: string` to `src/models/ModelClient.ts` `Message`.
- [ ] Ensure `id` is internal bookkeeping only and not relied on by provider payloads.
- [ ] Update `SessionState.clonePromptMessage()` to preserve `id`.
- [ ] Update `SessionState.clonePromptMessage()` to preserve `timestamp`.
- [ ] Update canonical-history-to-prompt-history conversion so reseeded user/assistant messages can carry generated IDs/timestamps when promoted into prompt history.
- [ ] Generate `id` for user messages when they enter runtime state.
- [ ] Generate `timestamp` for user messages when they enter runtime state.
- [ ] Generate `id` for assistant messages when the model response is recorded.
- [ ] Generate `timestamp` for assistant messages when the model response is recorded.
- [ ] Generate `id` for tool-result messages when tool output is recorded.
- [ ] Generate `timestamp` for tool-result messages when tool output is recorded.
- [ ] Keep metadata optional for backward compatibility with pre-context-management sessions.

### TokenBudget

- [ ] Create `src/agent/TokenBudget.ts`.
- [ ] Add `ModelMetadata` type for per-model `contextWindowSize` and `maxOutputTokens`.
- [ ] Add `TokenBudgetConfig` with:
- [ ] `modelMetadata`
- [ ] `defaultContextWindowSize`
- [ ] `defaultMaxOutputTokens`
- [ ] `microcompactRatio`
- [ ] `projectionRatio`
- [ ] `overflowRatio`
- [ ] `safetyMargin`
- [ ] Implement `getEffectiveWindow(modelName)`.
- [ ] Implement `estimateTokens(messages, lastKnownUsage?)`.
- [ ] Implement `assessPressure(modelName, messages, lastKnownUsage?)`.
- [ ] Use API-grounded token usage only when the prompt prefix is unchanged.
- [ ] Invalidate `lastKnownUsage` when microcompact rewrites any content.
- [ ] Invalidate `lastKnownUsage` when projection drops or reorders messages.
- [ ] Invalidate `lastKnownUsage` when summarization replaces earlier history.
- [ ] Fall back to full prompt re-estimation when the baseline is invalid.
- [ ] Log a warning when active model metadata is missing and defaults are used.

### ToolResultPersistence

- [ ] Create `src/agent/ToolResultPersistence.ts`.
- [ ] Add config for:
- [ ] `defaultMaxResultChars`
- [ ] `perToolThresholds`
- [ ] `perMessageBudgetChars`
- [ ] `previewSizeBytes`
- [ ] `storageDir`
- [ ] Implement `processResult(toolName, toolCallId, content, conversationId)` or equivalent conversation-aware API.
- [ ] Persist oversized tool output to `<storageDir>/<conversationId>/tool-results/<toolCallId>.txt`.
- [ ] Replace oversized content with preview stub that includes persisted path.
- [ ] Cut preview at a newline boundary when possible.
- [ ] Implement per-message aggregate budget enforcement across multiple tool results.
- [ ] Replace the largest tool results first until under aggregate budget.
- [ ] Return original content if persistence fails.
- [ ] Support per-tool threshold overrides.
- [ ] Gate persistence behavior if the required file-read tool is not available yet.
- [ ] Document or encode fallback behavior when persisted results are not model-recoverable yet.

### SessionManager cleanup and crash recovery

- [ ] Update `src/agent/SessionManager.ts` to kick off startup sweep from constructor.
- [ ] Add `sweepOrphanedTempFiles(storageDir)` to `SessionManager`.
- [ ] Sweep directories older than session TTL.
- [ ] Ignore missing storage directory on first run.
- [ ] Keep startup sweep fire-and-forget and non-fatal.
- [ ] Add `cleanupConversationTempDir(conversationId)` to `SessionManager`.
- [ ] Call temp-dir cleanup during TTL eviction.
- [ ] Call temp-dir cleanup during capacity eviction.
- [ ] Keep eviction cleanup fire-and-forget and explicitly swallowed on failure.
- [ ] Abort forked agents before eviction cleanup and deletion.
- [ ] Ensure cleanup path covers both tool-result files and session-memory files.

### Config

- [ ] Add `context` section to `src/config/schema.ts`.
- [ ] Add `context.model_metadata`.
- [ ] Add `context.default_context_window_size`.
- [ ] Add `context.default_max_output_tokens`.
- [ ] Add `context.tool_result_persistence`.
- [ ] Add thresholds config under `context`.
- [ ] Add config defaults that match the implementation plan.
- [ ] Update config fixtures/tests to include the new `context` section.
- [ ] Update `config.example.yaml` with the new context-management settings.

### Validation

- [ ] Message metadata is created at all runtime message creation points.
- [ ] `clonePromptMessage` preserves `id` and `timestamp`.
- [ ] `TokenBudget.assessPressure()` resolves per-model context windows correctly.
- [ ] Unknown model names use defaults and log a warning.
- [ ] Baseline invalidation works after microcompact/projection/summary rewrites.
- [ ] Oversized tool results are persisted and preview stubs are returned.
- [ ] Largest results are externalized first when aggregate budget is exceeded.
- [ ] Persistence failure falls back to original inline result.
- [ ] Startup sweep deletes orphaned directories older than session TTL.
- [ ] Startup sweep ignores fresh directories.
- [ ] Session eviction triggers best-effort temp-dir cleanup.
- [ ] Capacity eviction triggers best-effort temp-dir cleanup.

---

## Step 2: Microcompact + prepareContextForModelCall pipeline shell

### Microcompact

- [ ] Create `src/agent/Microcompact.ts`.
- [ ] Add `MicrocompactConfig` with:
- [ ] `gapThresholdMinutes`
- [ ] `keepRecentResults`
- [ ] `compactableTools`
- [ ] `clearedMarker`
- [ ] Initialize compactable tools with current runtime reality (`web_search` only).
- [ ] Implement gap detection from the last assistant message timestamp.
- [ ] Skip gap-based clearing when the last assistant message has no timestamp.
- [ ] Walk tool-result messages newest-to-oldest.
- [ ] Preserve the most recent `keepRecentResults` compactable tool results.
- [ ] Replace older compactable results with cleared marker.
- [ ] Do not touch non-tool messages.
- [ ] Do not touch non-compactable tool results.
- [ ] Return `tokensFreed` and `resultsCleared`.

### Pipeline shell

- [ ] Create `src/agent/prepareContextForModelCall.ts`.
- [ ] Define a dependency-injected pipeline function for per-model-step context prep.
- [ ] Accept raw `messages`, `modelName`, `lastKnownUsage`, and required collaborators.
- [ ] Start with `ToolResultPersistence.enforceMessageBudget()`.
- [ ] Then run `Microcompact.compact()`.
- [ ] Track whether any rewrite occurred during the pass.
- [ ] Feed rewrite status back into `TokenBudget` baseline invalidation logic.
- [ ] Return prepared messages plus pipeline metadata needed by the caller.

### TurnExecutor integration

- [ ] Update `src/agent/TurnExecutor.ts` to call `prepareContextForModelCall()` before every `client.generate()` call.
- [ ] Do not limit context prep to the first model call in a turn.
- [ ] Thread `modelName` into the pipeline.
- [ ] Thread `lastKnownUsage` into the pipeline.
- [ ] Refresh `lastKnownUsage` after each successful model response.
- [ ] Preserve existing event semantics (`text_delta`, `tool_start`, `tool_end`, `done`).
- [ ] Keep the executor loop behavior unchanged apart from message preparation.

### Validation

- [ ] Tool results clear only after the configured inactivity gap.
- [ ] Recent compactable results are preserved regardless of gap.
- [ ] Non-compactable tool outputs remain intact.
- [ ] No-op microcompact leaves messages unchanged and baseline intact.
- [ ] `prepareContextForModelCall()` runs on every ReAct loop iteration.
- [ ] Mid-turn context growth is bounded by repeated preparation passes.

---

## Step 3: SessionMemory extraction and lifecycle

### SessionMemory module

- [ ] Create `src/agent/SessionMemory.ts`.
- [ ] Store session-memory content on disk at `/tmp/digitalme-agent/<conversation-id>/session-memory.md` or configured storage path.
- [ ] Keep extraction metadata in memory on the `SessionMemory` instance:
- [ ] `lastSummarizedMessageId`
- [ ] `tokensAtLastExtraction`
- [ ] `extractionStartedAt`
- [ ] `sessionMemoryInitialized`
- [ ] `toolCallsSinceLastExtraction`
- [ ] Implement `shouldExtract(currentTokenCount)`.
- [ ] Implement `extract(messages, hook/runtime context)` as a non-blocking fork launch.
- [ ] Implement `getMemory()` by reading the memory file from disk.
- [ ] Implement `waitForExtraction(timeoutMs?)`.
- [ ] Implement stale-extraction detection.
- [ ] Implement `clear()` to delete/reset session memory on reseed.
- [ ] Serialize extraction so overlapping extractions do not run concurrently.

### Session memory prompt + template

- [ ] Create `src/agent/SessionMemoryPrompt.ts`.
- [ ] Add the session-memory markdown template with all required preserved headings and italic instruction lines.
- [ ] Add extraction prompt that:
- [ ] excludes system prompt/persona configuration from captured notes
- [ ] instructs the forked agent to use only the Edit tool
- [ ] preserves file structure exactly
- [ ] writes detailed, info-dense conversational memory
- [ ] respects section-size constraints
- [ ] updates `Current State` every extraction

### SessionMemoryHook

- [ ] Create `src/agent/hooks/SessionMemoryHook.ts`.
- [ ] Use the existing `PostTurnHookContext` contract from track 08.
- [ ] Read prompt history from `sessionState`.
- [ ] Read token/tool-call growth from `lastResult`.
- [ ] Check extraction thresholds before launching a fork.
- [ ] Spawn forked extraction agent via existing fork runtime.
- [ ] Restrict the fork to the Edit tool on the session-memory file.
- [ ] Ensure hook returns immediately after scheduling the fork.
- [ ] Ensure hook does not mutate session state destructively.

### SessionRuntime integration

- [ ] Register `SessionMemoryHook` in `SessionRuntime` when `context.session_memory.enabled` is true.
- [ ] Keep hook execution fire-and-forget after successful turn completion.
- [ ] On platform reseed, clear session memory via `SessionMemory.clear()`.
- [ ] Ensure session-memory lifecycle is scoped to conversation/session runtime.

### Config

- [ ] Add `context.session_memory.enabled`.
- [ ] Add `context.session_memory.extraction_model`.
- [ ] Add `context.session_memory.tokens_between_updates`.
- [ ] Add `context.session_memory.tool_calls_between_updates`.
- [ ] Add `context.session_memory.minimum_tokens_to_init`.
- [ ] Add `context.session_memory.max_total_tokens`.
- [ ] Add `context.session_memory.max_section_tokens`.

### Validation

- [ ] Extraction triggers after configured token growth.
- [ ] Extraction triggers after configured tool-call growth.
- [ ] Extraction does not trigger before the initialization threshold.
- [ ] Session memory file is created in the expected conversation temp directory.
- [ ] Session memory content matches the template structure.
- [ ] `waitForExtraction()` blocks compaction only up to configured timeout.
- [ ] Stale extraction is skipped rather than waited on indefinitely.
- [ ] Memory is cleared on platform reseed.
- [ ] Hook execution does not delay SSE completion.
- [ ] No overlapping extraction forks run for the same conversation.

---

## Step 4: SessionMemoryCompact + ConversationSummaryBuilder + PromptProjector + PostCompactRecovery

### Message grouping

- [ ] Implement `groupMessages(messages)` helper in the compaction layer.
- [ ] Group one assistant `toolCalls[]` message plus all matching tool results as a single atomic unit.
- [ ] Treat plain assistant text messages as single-message groups.
- [ ] Treat plain user messages as single-message groups.
- [ ] Preserve group boundaries during keep/discard calculations.

### SessionMemoryCompact

- [ ] Create `src/agent/SessionMemoryCompact.ts`.
- [ ] Wait for in-progress extraction before attempting memory-based compaction.
- [ ] Skip waiting if extraction is stale.
- [ ] Load session memory from disk.
- [ ] Return `null` when the file is empty or still the bare template.
- [ ] Truncate oversized sections before using memory content in compaction.
- [ ] Find the group containing `lastSummarizedMessageId`.
- [ ] Expand backward by whole groups to satisfy `minTokens`.
- [ ] Expand backward by whole groups to satisfy `minTextBlockMessages`.
- [ ] Enforce `maxTokens` hard cap.
- [ ] Build compacted messages with:
- [ ] compact boundary marker
- [ ] summary/session-memory message
- [ ] preserved group tail
- [ ] Return pre/post token counts for metrics.

### ConversationSummaryBuilder

- [ ] Create `src/agent/ConversationSummaryBuilder.ts`.
- [ ] Support separate summarization model override.
- [ ] Generate summary only when session memory compaction is unavailable.
- [ ] Use a no-tools summarization prompt.
- [ ] Tailor prompt content to conversational continuity rather than coding state.
- [ ] Require `<analysis>` + `<summary>` output structure.
- [ ] Strip `<analysis>` before storing/using the summary.
- [ ] Return `ConversationSummary` with text, coverage, timestamp, and estimated tokens.
- [ ] Cache generated summary on `SessionState`.
- [ ] Clear cached summary on platform reseed.

### PromptProjector

- [ ] Create `src/agent/PromptProjector.ts`.
- [ ] Keep system prompt ownership outside the projector.
- [ ] Accept system prompt output plus history components as input.
- [ ] Prefer session memory over one-shot summary when both are available.
- [ ] Insert context block only when pressure is at least `projection`.
- [ ] Preserve a bounded recent tail of raw messages.
- [ ] Size recent tail using token budget.
- [ ] Ensure latest user message is present exactly once.
- [ ] Shrink recent tail when still over effective window.
- [ ] Omit history context block entirely in `nominal` pressure band.

### PostCompactRecovery

- [ ] Create `src/agent/PostCompactRecovery.ts`.
- [ ] Restrict recovery content to user-role conversational context only.
- [ ] Do not re-inject persona prompt.
- [ ] Do not re-inject tool definitions.
- [ ] Support optional `characterContext`.
- [ ] Enforce `maxRecoveryTokens`.
- [ ] Insert recovery messages after summary/session-memory block when appropriate.

### SessionState updates

- [ ] Add `private summary?: ConversationSummary` to `SessionState`.
- [ ] Add `getSummary()`.
- [ ] Add `setSummary(summary)`.
- [ ] Clear summary on platform reseed.
- [ ] Keep canonical history and prompt history ownership unchanged.

### Pipeline expansion

- [ ] Extend `prepareContextForModelCall()` to:
- [ ] assess pressure with `TokenBudget`
- [ ] try `SessionMemoryCompact` first
- [ ] fall back to `ConversationSummaryBuilder`
- [ ] apply `PostCompactRecovery`
- [ ] build projected history with `PromptProjector`
- [ ] mark baseline invalid when any of the above rewrite messages

### Validation

- [ ] `groupMessages()` never splits assistant-tool groups.
- [ ] Session-memory compaction preserves whole groups at the boundary.
- [ ] Session-memory compaction returns `null` when no usable memory exists.
- [ ] Summary generation captures relationship, facts, commitments, and ongoing topics.
- [ ] `<analysis>` is stripped and never returned to the main model context.
- [ ] Projector prefers session memory over summary.
- [ ] Projector omits context block in nominal band.
- [ ] Recent tail respects token budget and keeps latest user message.
- [ ] Post-compact recovery injects only character-specific user-role context.
- [ ] Summary is cached on `SessionState` and cleared on reseed.

---

## Step 5: ReactiveCompact + MaxOutputRecovery

### ReactiveCompact

- [ ] Create `src/agent/ReactiveCompact.ts`.
- [ ] Add one-shot retry guard per turn.
- [ ] On overflow error, summarize everything except the most recent aggressive tail.
- [ ] Rebuild projected context with the aggressive summary.
- [ ] Apply post-compact recovery.
- [ ] If still over threshold, truncate the summary itself.
- [ ] Retry the model call once with the compacted context.
- [ ] Surface error if overflow persists after retry.

### MaxOutputRecovery

- [ ] Create `src/agent/MaxOutputRecovery.ts`.
- [ ] Detect truncated model responses.
- [ ] Support escalated max-output-token retry when applicable.
- [ ] Build continuation message:
- [ ] direct resume
- [ ] no apology
- [ ] no recap
- [ ] concise continuation
- [ ] Limit continuation retries to configured max.
- [ ] Return final truncated output when retries are exhausted.

### TurnExecutor integration

- [ ] Catch model API overflow errors in `TurnExecutor`.
- [ ] Route overflow errors through `ReactiveCompact`.
- [ ] Route truncated outputs through `MaxOutputRecovery`.
- [ ] Reset reactive-compact guard at the start of each turn.
- [ ] Maintain existing SSE event behavior around final successful completion.
- [ ] Avoid infinite retry loops across overflow and truncation paths.

### Config

- [ ] Add `context.summary.enabled`.
- [ ] Add `context.summary.model`.
- [ ] Add `context.summary.max_summary_tokens`.
- [ ] Add `context.summary.preserve_recent_messages`.
- [ ] Add `context.reactive_compact.max_retries`.
- [ ] Add `context.reactive_compact.aggressive_preserve_messages`.
- [ ] Add `context.max_output_recovery.max_retries`.

### Validation

- [ ] Overflow error triggers aggressive compact and single retry.
- [ ] Second overflow after reactive compact surfaces failure.
- [ ] Reactive compact one-shot guard prevents loops.
- [ ] Truncation triggers escalated max-output retry when available.
- [ ] Truncation falls back to continuation-message retry when escalation is unavailable or exhausted.
- [ ] Continuation retries stop at configured limit.
- [ ] Final truncated output is returned when recovery cannot complete the response.

---

## Cross-Cutting Integration Work

- [ ] Create `src/agent/types/context.ts` for shared context-management types.
- [ ] Export new context modules from appropriate `index.ts` files.
- [ ] Keep dependency injection boundaries explicit for all new modules.
- [ ] Thread new config through constructor wiring (`SessionManager` -> `SessionRuntime` -> `TurnExecutor` / helpers).
- [ ] Update rollout/event recording if new context-management events are required.
- [ ] Ensure context management does not alter platform-authoritative canonical history semantics.
- [ ] Ensure prompt history remains an internal runtime artifact only.
- [ ] Ensure compaction/projection never rewrites canonical history.
- [ ] Ensure reseed path clears local summary/session-memory artifacts but preserves canonical platform ownership.

---

## Testing Strategy

- [ ] Add unit tests for `TokenBudget`.
- [ ] Add unit tests for `ToolResultPersistence`.
- [ ] Add unit tests for `Microcompact`.
- [ ] Add unit tests for `groupMessages`.
- [ ] Add unit tests for `SessionMemoryCompact`.
- [ ] Add unit tests for `ConversationSummaryBuilder`.
- [ ] Add unit tests for `PromptProjector`.
- [ ] Add unit tests for `PostCompactRecovery`.
- [ ] Add unit tests for `ReactiveCompact`.
- [ ] Add unit tests for `MaxOutputRecovery`.
- [ ] Add integration tests for `prepareContextForModelCall()` across pressure bands.
- [ ] Add integration tests for `TurnExecutor` with repeated tool cycles and mid-turn growth.
- [ ] Add integration tests for `SessionRuntime` post-turn extraction behavior.
- [ ] Add integration tests for `SessionManager` cleanup + startup sweep.
- [ ] Add regression tests for normal short conversations with context management effectively inactive.
- [ ] Add regression tests for reseed behavior clearing summary and session-memory artifacts.
- [ ] Add provider-facing regression tests ensuring new `Message` metadata does not leak into provider payloads.

---

## Rollout Order

1. Land Step 1: metadata, token budget, tool-result persistence, config, cleanup.
2. Land Step 2: microcompact and the per-model-step preparation pipeline shell.
3. Land Step 3: session-memory extraction and lifecycle.
4. Land Step 4: compaction, summarization, projection, and recovery context.
5. Land Step 5: overflow recovery and max-output recovery.
6. Run full regression pass across standard single-turn and multi-tool flows.

---

## Done Criteria

- [ ] Prompt growth is bounded relative to effective model context window.
- [ ] Context preparation runs before every model call within a turn.
- [ ] Tool-result growth is controlled via persistence and/or budget enforcement.
- [ ] Old compactable tool output can be cleared safely after inactivity gaps.
- [ ] Session memory is extracted asynchronously without delaying user responses.
- [ ] Session-memory compaction preserves valid assistant-tool group boundaries.
- [ ] One-shot summarization is only used when session memory is unavailable.
- [ ] Canonical platform history remains the source of truth and is never compacted locally.
- [ ] Local summary and session-memory artifacts are cleared on platform reseed.
- [ ] Overflow recovery and max-output recovery are bounded and loop-safe.
- [ ] Temp-file cleanup works for normal eviction and crash recovery.
- [ ] New config is documented, validated, and covered by tests.
