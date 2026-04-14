# Transcript and Artifact Storage Tasks

This task list implements `IMPLEMENTATION_PLAN.md`. Work from `digitalme-agent/` unless a path says otherwise.

## Ground Rules

- Keep changes scoped to `digitalme-agent/`.
- Preserve existing behavior after each phase; run the narrow relevant tests before moving on.
- Use the existing `Message.id` field as the stable transcript identity.
- Make `Message.id` required; keep `Message.timestamp` optional.
- Do not introduce a separate artifact store. Extend `ToolResultPersistence`.
- Record system prompts in memory only; do not write them to transcript JSONL.
- Treat platform history as canonical when reconciliation detects divergence.

## Phase 0: Baseline and Fixtures

- [ ] Run the current tests to establish baseline:
  - `npm test`
- [ ] Add or update a test helper for constructing `Message` objects with generated `id` values.
  - Suggested location: `src/test/fixtures.ts` or a nearby existing test utility.
  - Helper should allow overriding any message field.
  - Helper may set `timestamp` by default, but tests should not rely on it unless needed.
- [ ] Identify all bare `Message` literals that will fail once `id` is required.
  - Use `rg "role: '(system|user|assistant|tool)'|role: \"(system|user|assistant|tool)\"" src -g '*.ts'`.

Verification:
- [ ] Existing tests still pass before functional edits, or failures are documented as baseline.

## Phase 1: Message Identity

- [ ] Update `src/models/ModelClient.ts`.
  - Add `generateId(): string`.
  - Change `Message.id?: string` to `Message.id: string`.
  - Keep `Message.timestamp?: string`.
  - Add `Message.synthetic?: boolean`.
- [ ] Update all production `Message` creation sites to set `id`.
  - `src/agent/TurnExecutor.ts`
  - `src/agent/SessionState.ts`
  - `src/agent/subagent/SubagentTool.ts`
  - Context helpers that create real prompt messages, such as compaction or recovery helpers.
- [ ] Keep `timestamp` on messages created by `TurnExecutor` and platform-history seeding.
- [ ] Update tests and fixtures to use the new helper or explicitly set `id`.
- [ ] Verify provider clients ignore `id`, `timestamp`, and `synthetic` when building provider requests.

Verification:
- [ ] `npm test -- src/models/client/AnthropicClient.test.ts`
- [ ] `npm test -- src/models/client/GoogleCompletionClient.test.ts`
- [ ] `npm test -- src/agent/context`
- [ ] `npm test`

## Phase 2: Single Session Message Array

- [ ] Refactor `src/agent/SessionState.ts`.
  - Replace `canonicalHistory` and `promptHistory` with one private `messages: Message[]`.
  - Keep a clone helper that preserves `id`, `timestamp`, `synthetic`, tool calls, tool result metadata, and content.
  - Add `getMessages(): Message[]`.
  - Make `getCanonicalHistory()` compute a filtered user/assistant view.
  - Exclude assistant tool-call messages.
  - Exclude messages with `synthetic: true`.
  - Add `appendMessages(newMessages: Message[])`.
  - Add `initializeFromTranscript(messages: Message[])`.
  - Update `reconcileWithPlatformHistory(history)` to rebuild `messages` from platform history on reseed.
  - Keep the existing warm-session behavior when platform history is empty.
  - Update `compactHistory(summary, startRevision)` to replace prompt-facing history with a synthetic summary message and preserve the intended platform reconciliation behavior.
  - Update `snapshot()` counters to reflect the new model.
- [ ] Update `src/agent/SessionRuntime.ts`.
  - Use `state.getMessages()` instead of `state.getPromptHistory()`.
  - Replace `commitTask()` usage with `appendMessages(result.newMessages)`.
- [ ] Update `src/agent/types.ts`.
  - Replace `TurnExecutionResult.promptMessages` with `newMessages: Message[]`.
- [ ] Update tests for the new `SessionState` API.

Verification:
- [ ] `npm test -- src/agent/SessionManager.test.ts`
- [ ] `npm test -- src/agent/TurnExecutor.test.ts`
- [ ] `npm test -- src/agent/context/SessionMemoryHook.test.ts` if present, otherwise run relevant context tests.
- [ ] `npm test`

## Phase 3: TurnExecutor New Message Lifecycle

- [ ] Refactor `src/agent/TurnExecutor.ts` message construction.
  - Build `initialMessages` as system prompt plus prior history only.
  - Create `TurnContext` before adding the new user message.
  - Capture `baselineLength = context.messages.length` before pushing the user message.
  - Push the user message into `context.messages`.
  - Push assistant tool-call messages as today.
  - Push tool result messages as today.
  - On final text, push the final assistant message into `context.messages`.
  - Return `newMessages: context.messages.slice(baselineLength)`.
- [ ] Ensure `prepareContextForModelCall()` rewrites do not break `baselineLength`.
  - If it replaces `context.messages`, the baseline index must still identify the current turn's first message.
  - Add a test covering a context rewrite after a tool result.
- [ ] Ensure every message created in this path has `id` and `timestamp`.

Verification:
- [ ] Add or update `TurnExecutor` tests:
  - user message included as first `newMessages` entry
  - final assistant included as last `newMessages` entry
  - tool-call and tool-result messages preserved in order
  - system prompt excluded from `newMessages`
- [ ] `npm test -- src/agent/TurnExecutor.test.ts`
- [ ] `npm test`

## Phase 4: Transcript Types and Recorder

- [ ] Add `src/agent/transcript/types.ts`.
  - Define `TranscriptEntry`.
  - Define `MessageEntry` with `parentId`, `message`, `isSidechain`, `agentId`, and `artifactRef`.
  - Define lifecycle entries:
    - `TaskStartedEntry`
    - `TaskCompletedEntry`
    - `TaskFailedEntry`
    - `SessionReseededEntry`
  - Define `ArtifactRef`.
  - Define any snapshot type imports or local interfaces needed.
- [ ] Add `src/agent/transcript/TranscriptRecorder.ts`.
  - Implement per-conversation file naming using the existing rollout hash scheme.
  - Preserve the existing `.digital_me_agent/rollouts` location.
  - Implement append-only JSONL writes.
  - Implement per-file write queues.
  - Implement optional batching with flush interval and max chunk size if doing so in this phase.
  - Implement `recordMessage(conversationId, message, opts)`.
  - `opts` must include `taskId`, `turnId`, `parentOverride`, `artifactRef`, `isSidechain`, and `agentId`.
  - Maintain `lastParentId` per conversation or sidechain key.
  - Do not advance `lastParentId` for lifecycle events.
  - For a tool result with `parentOverride`, write `parentId = parentOverride` and then advance the running cursor to the tool result message id.
  - Implement `recordLifecycleEvent(entry)`.
  - Implement `insertMessageChain(conversationId, messages, isSidechain, agentId, startingParentId)`.
  - Implement `loadTranscript(conversationId): Promise<{ messages: Message[]; leafId: string | null }>`.
  - Implement `seedParentId(conversationId, leafId)`.
  - Implement two-layer dedup with `entry.message.id`.
  - Rebuild dedup sets from disk on first access after restart.
  - Route sidechains to `<conv-hash>/subagents/agent-<agentId>.jsonl`.
- [ ] Keep or document lifecycle schema compatibility with existing rollout consumers.
- [ ] Replace `src/agent/RolloutRecorder.ts` imports with transcript recorder types.
- [ ] Remove `src/agent/RolloutRecorder.ts` after all references are migrated.

Verification:
- [ ] Add `TranscriptRecorder` unit tests:
  - valid JSONL writes
  - lifecycle entries do not advance parent chain
  - linear parent chain
  - tool-result DAG parent override
  - dedup prevents duplicate message writes
  - sidechain routing
  - restart rebuilds message set from JSONL
- [ ] `npm test -- src/agent/transcript`
- [ ] `npm test`

## Phase 5: Lifecycle Recording Integration

- [ ] Update `src/agent/SessionRuntime.ts`.
  - Replace `IRolloutRecorder` with `ITranscriptRecorder`.
  - Replace `record(...)` with `recordLifecycleEvent(...)`.
  - Preserve `task_started`, `task_completed`, `task_failed`, and `session_reseeded` entries.
  - Commit `result.newMessages` with `state.appendMessages()`.
- [ ] Update `src/agent/SessionManager.ts`.
  - Construct or inject `TranscriptRecorder`.
  - Pass the same recorder to `SessionRuntime` and `TurnExecutor`.
  - Keep the same storage location used by current rollout recorder unless config says otherwise.
- [ ] Update DI types and tests.

Verification:
- [ ] `npm test -- src/agent/SessionManager.test.ts`
- [ ] `npm test -- src/agent/SessionRuntime.test.ts` if present
- [ ] `npm test`

## Phase 6: Inline Dual Write in TurnExecutor

- [ ] Update `src/agent/TurnExecutor.ts` dependencies.
  - Add `ITranscriptRecorder`.
  - Ensure tests can inject a fake recorder.
- [ ] Add `recordMessage()` calls next to each new message push.
  - User message: record with task and turn metadata.
  - Assistant tool-call message: record with task and turn metadata.
  - Tool result message: record with `parentOverride: assistantMsg.id`.
  - Final assistant message: record with task and turn metadata.
- [ ] Decide error behavior for transcript write failure.
  - If transcript is required durability, fail the turn.
  - If transcript is best-effort, emit/log and continue.
  - Make the policy explicit in code and tests.
- [ ] Ensure events are emitted in the same user-visible order as before.

Verification:
- [ ] Add or update `TurnExecutor` tests:
  - fake recorder sees user, assistant tool-call, tool result, final assistant
  - tool result uses assistant id as parent override
  - system prompt is not recorded
  - transcript write failure follows the chosen policy
- [ ] `npm test -- src/agent/TurnExecutor.test.ts`
- [ ] `npm test`

## Phase 7: Transcript-Aware Tool Result Persistence

- [ ] Update `src/agent/context/ToolResultPersistence.ts`.
  - Change `processResult()` to return `{ content, artifactRef? }`.
  - Include `filePath`, `originalSize`, and `preview` in `ArtifactRef`.
  - Preserve fallback behavior when persistence fails.
  - Update `enforceMessageBudget()` for the new return type.
- [ ] Update `src/agent/context/prepareContextForModelCall.ts` call sites for the new API.
- [ ] Update `src/agent/TurnExecutor.ts`.
  - After tool execution and before pushing the tool message, call `processResult()`.
  - Use returned `content` in the tool message.
  - Pass returned `artifactRef` to `recordMessage()` when present.
- [ ] Remove legacy 2000-character rollout sanitization or move it so it does not truncate transcript message content.
- [ ] Keep per-message aggregate enforcement in `prepareContextForModelCall()` as a second pass.
- [ ] Defer global budget unless adding explicit config/schema support in this same change.

Verification:
- [ ] `npm test -- src/agent/context/ToolResultPersistence.test.ts`
- [ ] Add or update integration coverage:
  - large individual tool result is externalized before transcript record
  - transcript entry contains preview content and `artifactRef`
  - aggregate enforcement still rewrites oversized combined tool results
- [ ] `npm test`

## Phase 8: Resume from Transcript

- [ ] Implement `loadTranscript(conversationId)` in `TranscriptRecorder`.
  - Apply a max file size check before reading.
  - Parse JSONL safely; tolerate malformed trailing lines only if deliberately supported.
  - Build `Map<message.id, MessageEntry>` for message entries.
  - Ignore sidechain entries for main-conversation resume.
  - Find the newest non-sidechain leaf message.
  - Walk backward via `parentId`.
  - Detect cycles and stop safely.
  - Reverse to chronological order.
  - Recover orphaned parallel tool results under assistant tool-call messages.
  - Filter unresolved assistant tool-call messages when matching tool results are missing.
  - Append a synthetic continuation user message if the recovered chain ends on a user message.
  - Return `{ messages, leafId }`.
- [ ] Ensure synthetic continuation messages have `id`, `timestamp`, and `synthetic: true`.
- [ ] Ensure loaded messages preserve original `id` values for dedup.
- [ ] Ensure `leafId` points to the actual transcript leaf used to seed future writes.

Verification:
- [ ] Add `loadTranscript()` unit tests:
  - linear chain loads in order
  - newest leaf selected
  - cycle detection
  - parallel tool result sibling recovery
  - unresolved tool use filtering
  - interrupted user turn creates synthetic continuation
  - file size guard returns empty result or skips resume per policy
- [ ] `npm test -- src/agent/transcript`
- [ ] `npm test`

## Phase 9: SessionManager Resume Wiring

- [ ] Update `src/agent/SessionManager.ts`.
  - Make `getOrCreateRuntime()` async.
  - Add `await` at the call site in `execute()`.
  - On cold start, call `transcriptRecorder.loadTranscript(conversationId)`.
  - If transcript messages exist, initialize `SessionState` from transcript.
  - If `leafId` exists, call `transcriptRecorder.seedParentId(conversationId, leafId)`.
  - Run platform history reconciliation after transcript initialization.
  - If reconciliation reseeds from platform history, ensure recorder parent cursor is reset to match the new in-memory state or intentionally starts a new chain.
  - If no transcript exists, preserve existing platform-history initialization.
- [ ] Add tests for cold-start behavior.
  - no transcript: platform history initializes state
  - transcript exists: transcript initializes state
  - transcript exists and platform diverges: platform reseed wins
  - recorder parent cursor is seeded after resume

Verification:
- [ ] `npm test -- src/agent/SessionManager.test.ts`
- [ ] `npm test`

## Phase 10: Forked Agent and Subagent Sidechains

- [ ] Update `src/agent/fork/ForkedAgent.ts`.
  - Pass sidechain recording context into forked runs.
  - Honor `skipTranscript`.
  - Ensure forked agent messages route with `isSidechain: true` and a stable `agentId`.
- [ ] Update `src/agent/subagent/SubagentTool.ts`.
  - Ensure system and user prompt messages have `id`.
  - Pass sidechain context to the turn executor or recorder.
  - Create sidechain metadata sidecar with agent type, description, and resumable config.
- [ ] Ensure the main transcript only contains the parent tool call and summarized tool result.
- [ ] Ensure sidechain transcript writes do not mutate main conversation parent cursor.

Verification:
- [ ] `npm test -- src/agent/fork/ForkedAgent.test.ts`
- [ ] `npm test -- src/agent/subagent/SubagentTool.test.ts`
- [ ] Add sidechain routing tests if not covered by recorder tests.
- [ ] `npm test`

## Phase 11: Retention and Cleanup

- [ ] Define max transcript read size, defaulting to 50 MB unless config already provides a better value.
- [ ] Define retention policy:
  - max age per conversation
  - max total size per conversation
  - behavior when limits are exceeded
- [ ] Decide whether retention is config-driven in this implementation or documented for a follow-up.
- [ ] Ensure `SessionManager` cleanup does not delete durable transcripts when cleaning temp tool-result/session-memory directories.
- [ ] Ensure artifact files referenced by transcripts are not deleted by TTL temp cleanup unless that is explicitly intended.

Verification:
- [ ] Add cleanup/retention tests for whatever policy is implemented now.
- [ ] `npm test -- src/agent/SessionManager.test.ts`
- [ ] `npm test`

## Phase 12: End-to-End Verification

- [ ] Run full unit and integration suite:
  - `npm test`
- [ ] Run TypeScript build:
  - `npm run build`
- [ ] Manually inspect generated transcript JSONL for a tool-using conversation.
  - Contains lifecycle events.
  - Contains user, assistant tool-call, tool result, final assistant messages.
  - Uses `message.id`, not `uuid`.
  - Uses `parentId`, not `parentUuid`.
  - Does not include system prompt as a message entry.
  - Large tool output is represented by preview plus `artifactRef`.
- [ ] Manually verify resume:
  - Start a conversation with a tool call.
  - Evict or restart the agent.
  - Submit another turn for the same conversation.
  - Confirm restored context includes prior tool-call detail.
  - Confirm new transcript entries chain from the previous leaf.
- [ ] Manually verify platform divergence:
  - Start from a transcript-backed conversation.
  - Send platform history that diverges.
  - Confirm session reseeds from platform history and records `session_reseeded`.

## Final Acceptance Checklist

- [ ] `Message.id` is required and assigned everywhere production code creates a `Message`.
- [ ] `Message.timestamp` remains optional.
- [ ] `SessionState` uses one source-of-truth message array.
- [ ] `getCanonicalHistory()` excludes tool metadata and synthetic messages.
- [ ] `TurnExecutionResult` returns `newMessages`, not `promptMessages`.
- [ ] `TurnExecutor` pushes and records user, assistant tool-call, tool result, and final assistant messages.
- [ ] System prompts are not transcript entries.
- [ ] `TranscriptRecorder` writes lifecycle events and message entries to JSONL.
- [ ] Lifecycle events do not advance parent chains.
- [ ] Dedup uses `message.id`.
- [ ] Resume loads transcript messages and seeds the recorder parent cursor.
- [ ] Large per-tool results are externalized before transcript recording.
- [ ] Transcript entries can include `artifactRef`.
- [ ] Sidechain transcripts are isolated from the main transcript.
- [ ] Existing rollout location compatibility is preserved or migration is documented.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
