# Transcript and Artifact Storage

## Goal

Persist the full message history as a unified transcript — the transcript IS the execution record.

Following claudy's proven pattern: one append-only JSONL per conversation where every message (user, assistant, tool call, tool result) is a transcript entry. No separate "execution log" vs. "transcript" — the conversation is the execution record.

This makes `digitalme-agent` better at:

- debugging production behavior (full tool inputs/outputs recoverable)
- reconstructing request execution history
- restoring continuity after restart or reseed (resume from transcript)
- externalizing large tool artifacts safely

## Current State

### In-Memory Message History (3 arrays → merge to 1)

Today the agent maintains three separate in-memory data structures for message history:

1. **`context.messages: Message[]`** (`TurnContext.ts`) — per-turn working copy. Starts with system prompt + history + user message, grows during the turn, discarded when the turn ends.

2. **`SessionState.promptHistory: Message[]`** (`SessionState.ts`) — full detail including tool calls and results. Updated by `commitTask()` via `promptMessages` batch. Persists across turns for the session lifetime (30 min TTL). Fed into the next turn as `submission.promptHistory`.

3. **`SessionState.canonicalHistory: HistoryMessage[]`** (`SessionState.ts`) — stripped to user/assistant text pairs only. Used for platform history reconciliation (`reconcileWithPlatformHistory`).

**Problem:** Three arrays holding overlapping data is unnecessary complexity. Claudy uses a single `messages` array (`QueryEngine.mutableMessages`). `canonicalHistory` is derivable by filtering the full history.

**Change:** Merge into one `SessionState.messages: Message[]` array. `canonicalHistory` becomes a computed view (filter for user/assistant messages without tool metadata). `context.messages` stays as the per-turn working copy (our `TurnExecutor` builds a per-turn context from the session-level array, similar to how claudy's `QueryEngine.submitMessage()` computes per-turn context from `mutableMessages`).

### Dual Write (missing — needs to be added)

Claudy guarantees that every message reaches both memory and disk, but achieves this through a **reactive observer pattern** — a React `useEffect` hook (`useLogMessages`) watches the messages array and incrementally calls `recordTranscript()` when it detects new entries. The message creation sites (`QueryEngine.submitMessage()`) have no awareness of recording.

Our agent is a headless Express server with no reactive UI layer. Instead of adding an observer, we use **inline dual write** — each `context.messages.push()` call site in `TurnExecutor` also calls `recorder.record()` explicitly. This gives us the same guarantee (every message hits memory + disk) with a simpler, more predictable mechanism suited to our architecture.

Our agent currently only does the memory push. No message content hits disk. The `promptMessages` batch returned from `TurnExecutor.run()` feeds the in-memory history but is not persisted.

**Change:** Add inline disk recording alongside each `context.messages.push()` call in `TurnExecutor`. Two operations, same call site. Eliminate the `promptMessages` batch — after the turn, append the new messages from `context.messages` directly to `SessionState.messages`.

### On-Disk Persistence (lifecycle summaries only → full transcript)

Today the only disk persistence is `RolloutRecorder.ts` with 4 lifecycle event types (`task_started`, `task_completed`, `task_failed`, `session_reseeded`). No message content is recorded.

**Change:** Replace with `TranscriptRecorder` that records every message inline during the turn, plus lifecycle events.

### Resume (not possible → load from transcript)

Today, when a session is evicted from memory (30 min TTL), the full execution detail is lost forever. There is no resume capability.

**Change:** Add `loadTranscript()` that reads the JSONL, rebuilds the conversation chain via `parentId`, strips transcript metadata, and returns `Message[]` to initialize `SessionState.messages`. This enables resume after eviction.

## Prerequisite: Make `id` Required on Message

The `Message` interface (`src/models/ModelClient.ts`) already has an optional `id?: string` field and an optional `timestamp?: string` field. Both are already populated at all creation sites in `TurnExecutor.run()` (lines 110, 173, 202) and `SessionState.canonicalToPromptHistory()` using `crypto.randomUUID()` and `new Date().toISOString()`. The `id` field serves exactly the role we need for transcript identity. The `timestamp` field is already used by microcompact for gap detection.

Every message needs a stable identity for:

- **Dedup on write:** two-layer dedup (caller filters + recorder double-checks) prevents re-recording history messages on resume/replay
- **Conversation chain:** `parentId` linking enables reconstructing the conversation tree
- **Artifact references:** externalized content is keyed by message/tool-call identity

### Change to Message interface

Make `id` required (was optional). Keep `timestamp` optional. Add a `generateId()` convenience function. No new fields needed — standardize on the existing `id` field.

```typescript
// src/models/ModelClient.ts
import crypto from 'node:crypto';

export function generateId(): string {
  return crypto.randomUUID();
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** Stable UUID for transcript dedup, parentId chaining, and artifact references. Required. */
  id: string;
  /** ISO 8601 timestamp, set at creation time. Used by microcompact and transcript ordering.
   *  Optional — already set at all TurnExecutor creation sites. Context helpers and tests
   *  that construct bare messages for budget/compaction logic don't need to set this. */
  timestamp?: string;
  /** True for internally-generated messages (compaction summaries, synthetic continuations).
   *  Excluded from getCanonicalHistory() to prevent leaking into platform reconciliation. */
  synthetic?: boolean;
}
```

### Migration from optional to required

Making `id` required is essential for transcript dedup and chaining — it must be a hard requirement. However, making `timestamp` required has a **broader blast radius** than it might appear: many test fixtures and context helpers (TokenBudget, ToolResultPersistence, Microcompact, provider client tests, groupMessages, ReactiveCompact, PromptProjector) construct `Message` objects without `timestamp`. Making it required would force updates across ~20+ test files.

**Decision: make `id` required, keep `timestamp` optional.** Only transcript participants (messages that flow through TurnExecutor) need timestamps, and those already set them. Context helpers and tests that construct bare messages for budget/compaction logic shouldn't need to care about timestamps. The recorder can default to `new Date().toISOString()` if `timestamp` is missing.

Steps:
1. Change `id?: string` to `id: string` — this is the hard requirement for transcript identity
2. Keep `timestamp?: string` as optional — already populated at all TurnExecutor creation sites, optional elsewhere
3. Add `generateId()` convenience function alongside existing `crypto.randomUUID()` calls
4. Add a `testMessage()` helper in test utils that auto-generates `id` (and optionally `timestamp`) to reduce test fixture churn
5. Fix TypeScript errors where messages are created without `id` (e.g., `compactHistory()` summary, tests that use bare `{ role, content }` objects)

### Identity assignment sites

Every place that creates a `Message` must set `id`. Transcript participants (TurnExecutor, SessionState) should also set `timestamp`; other callers (tests, context helpers) can omit it:

- `TurnExecutor.run()` — user message, assistant messages (tool-call and final), tool result messages (already done)
- `SessionState.canonicalToPromptHistory()` — platform history seeding (already done)
- `SessionState.compactHistory()` — the summary message (needs adding)
- `SubagentTool` — system and user prompt messages in `promptHistory` (needs adding)

### Impact on existing code

- `SessionState.clonePromptMessage()` — already copies `id` and `timestamp` (lines 28-33)
- Model clients (Anthropic, OpenAI, Google) — `id` is already ignored when building API requests (it's internal metadata, not sent to providers)
- Tests using `deepEqual` on messages — need to either use a `stripIds()` helper or assert on role/content individually since IDs are random

## Design: Unified In-Memory + On-Disk Architecture

### Core Principle

One in-memory `messages` array per session. Dual write at each message production site: push to memory + record to disk. The transcript JSONL is the durable record. On resume, the JSONL is loaded back into memory.

```
During session:
  TurnExecutor produces message
    → push to context.messages (for next LLM turn)
    → record to JSONL transcript (for persistence)
  Turn completes
    → append new messages to SessionState.messages (for next task)

On resume:
  JSONL transcript
    → loadTranscript() parses, walks parentId chain
    → strips transcript metadata (parentId, isSidechain, agentId)
    → returns Message[] → initializes SessionState.messages
```

### Merging SessionState to One Array

```typescript
// src/agent/SessionState.ts (after refactor)

export class SessionState {
  private messages: Message[] = [];  // single source of truth

  /** Full message history for LLM context */
  getMessages(): Message[] {
    return this.messages.map(cloneMessage);
  }

  /**
   * Canonical view for platform reconciliation — computed, not stored.
   * Excludes synthetic messages (e.g., compaction summaries) that are internal
   * to the agent and should not be visible to the platform.
   */
  getCanonicalHistory(): HistoryMessage[] {
    return this.messages
      .filter(m =>
        (m.role === 'user' || m.role === 'assistant')
        && !m.toolCalls
        && !m.synthetic  // exclude compaction summaries and other internal messages
      )
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' }));
  }

  /** After a turn completes, append new messages */
  appendMessages(newMessages: Message[]) {
    for (const msg of newMessages) {
      this.messages.push(cloneMessage(msg));
    }
    this.revision++;
  }

  /** On resume, initialize from transcript */
  initializeFromTranscript(messages: Message[]) {
    this.messages = messages.map(cloneMessage);
    this.revision++;
  }

  /** On platform reseed, replace from platform history */
  reconcileWithPlatformHistory(history: HistoryMessage[]): 'warm' | 'unchanged' | 'reseeded' {
    // same logic as today, but updates this.messages instead of two arrays
  }
}
```

### Eliminating promptMessages

Today `TurnExecutor.run()` assembles `promptMessages` at the end of the turn and returns it in `TurnExecutionResult`. `SessionRuntime.commitResult()` passes it to `SessionState.commitTask()`.

**Current slicing problem:** `initialMessages` in `TurnExecutor.run()` already includes the user message (line 110), so `context.messages.slice(initialMessages.length)` starts AFTER it — the user message would be dropped. Additionally, the final assistant text is never pushed to `context.messages`; it's only synthesized in the `promptMessages` return value (line 164).

After refactor:
- **Track the baseline before the user message:** Record `const baselineLength = context.messages.length` BEFORE pushing the user message. The user message, all tool-call/result messages, and the final assistant message are all pushed to `context.messages` during the turn.
- **Push the final assistant message:** When the model returns `final_text`, explicitly push `{ role: 'assistant', content: finalText, id: generateId(), timestamp: now }` to `context.messages` before returning.
- **Slice new messages:** `context.messages.slice(baselineLength)` now correctly contains: user message (first), any tool-call/result messages (middle), final assistant message (last).
- `TurnExecutor.run()` returns `newMessages: Message[]` (the slice) instead of `promptMessages`
- `SessionRuntime` calls `SessionState.appendMessages(newMessages)` instead of `commitTask(userMessage, finalText, promptMessages)`

This means `initialMessages` changes to: system prompt + history only (no user message). The user message is pushed separately after recording the baseline length.

### System Prompt

The system prompt is NOT recorded in the transcript. It's passed separately to the LLM API, is derivable from config, and changes with code deployments. (Matches claudy's approach.)

### TranscriptEntry Type

```typescript
// src/agent/transcript/types.ts

interface TranscriptEntry {
  type: 'message' | 'task_started' | 'task_completed' | 'task_failed'
       | 'session_reseeded';
  conversationId: string;
  taskId?: string;  // optional — session-level events may not have a task
  turnId?: number;
  timestamp: string;
}

/**
 * A message entry — the core of the transcript.
 * This is a Message (from ModelClient.ts) plus transcript metadata.
 * parentId is assigned by the recorder, not the caller.
 */
interface MessageEntry extends TranscriptEntry {
  type: 'message';
  parentId: string | null;  // assigned by recorder — points to the previous message's `id`
  message: Message;
  isSidechain?: boolean;  // true for forked/sub-agent messages
  agentId?: string;       // which agent produced this message
  /** Set when content was externalized to artifact store */
  artifactRef?: ArtifactRef;
}

interface TaskStartedEntry extends TranscriptEntry {
  type: 'task_started';
  session: SessionSnapshot;
  platformHistoryCount: number;
}

interface TaskCompletedEntry extends TranscriptEntry {
  type: 'task_completed';
  finalText: string;
  completedTurns: number;
  toolCallCount: number;
  tokenUsage?: TokenUsage;
  session: SessionSnapshot;
}

interface TaskFailedEntry extends TranscriptEntry {
  type: 'task_failed';
  error: string;
  turn: ActiveTurnSnapshot;
}

interface SessionReseededEntry extends TranscriptEntry {
  type: 'session_reseeded';
  historyCount: number;
}
```

### parentId Chaining

Following claudy, `parentId` is assigned by the recorder, not the caller:

- The recorder tracks a running `parentId` variable as it processes a chain of messages
- First message in a chain gets `parentId: null` (or a hint from the caller for continuation)
- Each subsequent message points to the previous message's `id`
- For tool results: the caller passes `parentOverride` (the spawning assistant message's `id`) to `recordMessage()` — so tool results point to the assistant that spawned the tool call, not the sequential previous message

This creates a DAG (not a linear chain) when parallel tool calls produce multiple tool results from a single assistant message.

**Non-chain participants:** Not all message types advance the `parentId` chain. Claudy has an `isChainParticipant()` check — lifecycle entries (`task_started`, `task_completed`, `task_failed`, `session_reseeded`) are recorded in the JSONL but do NOT update the running `parentId`. Only `message` entries advance the chain. This prevents lifecycle bookkeeping from disrupting the conversation DAG.

### Dedup: Two-Layer, Rebuilt from Disk

Following claudy's proven pattern:

**Layer 1 (Caller-side):** Before calling `insertMessageChain()`, the caller filters messages against a `messageSet` of already-recorded UUIDs. Only new messages are passed to the recorder.

**Layer 2 (Recorder-side):** `appendEntry()` double-checks `messageSet.has(entry.message.id)` before writing. Belt-and-suspenders safety.

**The `messageSet`:**
- Loaded from the JSONL on first access (memoized per conversation)
- Updated in-memory as entries are written (`messageSet.add(entry.message.id)`)
- Cleared after compaction (if/when we add compaction)
- On restart: rebuilt from JSONL on first access

This is needed because sessions can be resumed from transcript after the 30-min TTL eviction, and the transcript may already contain messages that the resumed session would re-encounter.

### TranscriptRecorder

The recorder exposes two distinct APIs: `recordLifecycleEvent()` for non-chain entries, and `recordMessage()` for inline per-message recording with automatic parentId chaining. The recorder maintains per-conversation mutable state (`lastParentId`) so callers never deal with parentId directly.

```typescript
// src/agent/transcript/TranscriptRecorder.ts

interface ITranscriptRecorder {
  /**
   * Record a single message inline during the turn.
   * The recorder maintains a running parentId per conversation:
   * - First message in a conversation gets parentId: null
   * - Each subsequent message's parentId = previous message's id
   * - Tool results: pass parentOverride to point back to the spawning assistant message's id
   *   (creates the DAG for parallel tool calls)
   *
   * This is the primary API for dual-write in TurnExecutor.
   */
  recordMessage(
    conversationId: string,
    message: Message,
    opts?: {
      taskId?: string;
      turnId?: number;
      /** Override parentId — used for tool results pointing to their spawning assistant */
      parentOverride?: string;
      /** Attach when tool result content was externalized by ToolResultPersistence */
      artifactRef?: ArtifactRef;
      isSidechain?: boolean;
      agentId?: string;
    },
  ): Promise<void>;

  /** Record a lifecycle event (task_started, task_completed, etc.) — does NOT advance the parentId chain */
  recordLifecycleEvent(entry: TranscriptEntry): Promise<void>;

  /**
   * Record a batch of messages with parentId assignment and dedup.
   * Used for sidechain recording and initial history seeding — NOT for inline dual-write.
   */
  insertMessageChain(
    conversationId: string,
    messages: Message[],
    isSidechain?: boolean,
    agentId?: string,
    startingParentId?: string | null,
  ): Promise<void>;

  /** Load transcript and rebuild conversation chain for resume.
   *  Returns the recovered messages AND the leaf message id (needed to seed parentId cursor). */
  loadTranscript(conversationId: string): Promise<{ messages: Message[]; leafId: string | null }>;

  /** Seed the parentId cursor for a conversation after resume, so the next
   *  recordMessage() chains correctly from the recovered leaf. */
  seedParentId(conversationId: string, leafId: string): void;
}
```

Single recorder instance handles routing for main transcript and agent sidechains. The recorder tracks `lastParentId` per conversation in a `Map<string, string | null>`, updated after each `recordMessage()` call.

**Resume seeding:** After a process restart, the `lastParentId` map is empty. `loadTranscript()` must seed the recorder's parent cursor to the recovered leaf message's `id` before any new `recordMessage()` calls, otherwise the first post-resume message gets `parentId: null` and splits the chain. `loadTranscript()` returns the leaf `id` alongside the messages, and the caller (SessionManager) calls `recorder.seedParentId(conversationId, leafId)` to initialize the cursor.

Implementation:
- Same append-only JSONL as RolloutRecorder (proven pattern, keep it)
- Same write-queue for concurrency safety with batching parameters:
  - **Flush interval:** 100ms (matches claudy) — entries are buffered and flushed in batches to reduce I/O syscalls
  - **Max chunk size:** 100MB per batch write — prevents unbounded memory if many entries queue up simultaneously
  - **Per-file queues:** each JSONL file (main + sidechains) has its own independent queue
- Per-conversation file naming (same hash scheme)
- `insertMessageChain()` assigns `parentId` and performs UUID dedup
- Routes entries based on `isSidechain` + `agentId` fields:
  - If both set → write to `<conv-hash>/subagents/agent-<agentId>.jsonl`
  - Otherwise → write to `<conv-hash>.jsonl`
- Agent transcript files created lazily on first write
- `loadTranscript()` parses JSONL, walks `parentId` chain, strips transcript metadata, returns `Message[]`

### Forked Agent and Subagent Transcripts

Following claudy, forked agents and subagents are treated identically at the transcript level. Each gets its own JSONL file under `subagents/`:

```
.digital_me_agent/rollouts/
  <conv-hash>.jsonl                              ← main transcript
  <conv-hash>/
    subagents/
      agent-<agentId>.jsonl                      ← agent's full internal history
      agent-<agentId>.meta.json                  ← agent metadata (type, description)
    artifacts/<toolCallId>.txt                   ← externalized content
```

**Agent metadata sidecar:** Each sub-agent gets a `.meta.json` file alongside its JSONL transcript, containing the agent type, description, and any configuration needed to resume the sub-agent. This follows claudy's pattern of writing `agent-{agentId}.meta.json` for resumption info.

The main transcript only sees the `tool_use` → `tool_result` pair (the agent's summarized output). The agent's internal conversation (its tool calls, results, intermediate reasoning) goes into its sidechain file.

Routing is in the recorder (`appendEntry` checks `isSidechain && agentId`), not per-agent instances. The `isSidechain` and `agentId` fields are stamped onto entries at write time, not on in-memory `Message` objects.

Ephemeral forks (e.g., internal work that doesn't need audit) can pass `agentId = undefined` to skip transcript recording entirely (matches claudy's `skipTranscript` pattern).

### Artifact Store — Relationship to ToolResultPersistence

**Important:** The existing `ToolResultPersistence` class (`src/agent/context/ToolResultPersistence.ts`) already handles large tool result externalization:
- `processResult()` persists individual results exceeding a per-tool threshold
- `enforceMessageBudget()` enforces per-message aggregate budget, externalizing largest results first
- Stores files at `{storageDir}/{conversationId}/tool-results/{toolCallId}.txt`
- Builds preview stubs with size info

**We do NOT create a separate ArtifactStore.** Instead, `ToolResultPersistence` becomes the backing implementation for transcript artifact references. The change is to add transcript awareness:

1. When `ToolResultPersistence.processResult()` externalizes content, it returns an `ArtifactRef` alongside the preview stub (not just the stub string)
2. The `ArtifactRef` is attached to the `MessageEntry` in the transcript, so the transcript records both the preview AND a pointer to the full content on disk
3. The existing config already covers two tiers:
   - Per-tool: `config.context.tool_result_persistence.default_max_result_chars` (currently 50K)
   - Per-message: `config.context.tool_result_persistence.per_message_budget_chars`

```typescript
// Extended return type for ToolResultPersistence.processResult()
interface PersistenceResult {
  content: string;  // preview stub or original (unchanged)
  artifactRef?: ArtifactRef;  // set only when content was externalized
}

interface ArtifactRef {
  filePath: string;
  originalSize: number;
  preview: string;  // first N bytes (config.previewSizeBytes)
}
```

This avoids double persistence and keeps a single source of truth for where externalized content lives. The transcript JSONL references the same files that `prepareContextForModelCall()` already creates.

The JSONL file and its companion directory coexist as siblings.

### What gets recorded (and what doesn't)

**Recorded inline during turn (new messages only, dual write with in-memory push):**
1. User message → push to `context.messages` + record `MessageEntry` to JSONL
2. Each assistant tool-call message → push to `context.messages` + record to JSONL
3. Each tool result message → push to `context.messages` + record to JSONL (externalized if content > 50KB)
4. Final assistant text message → push to `context.messages` + record to JSONL

**Recorded per task (lifecycle):**
- `task_started` with session snapshot
- `task_completed` with result summary
- `task_failed` with error
- `session_reseeded` on history divergence

**NOT recorded:**
- System prompt — derivable from config. The system prompt is part of `initialMessages` (before the baseline), so it's excluded from the new-messages slice. For subagents, the system prompt is passed via `promptHistory` which also lands in `initialMessages` — same exclusion applies. All messages still need `id` and `timestamp` for the in-memory array even if they're not transcribed.
- `AgentEvent` stream (text_delta, tool_start, tool_end, done) — ephemeral UI events
- Re-played history messages — dedup by UUID prevents this

### Example Transcript Output

After one turn with a tool call, the JSONL looks like:

```jsonl
{"type":"task_started","conversationId":"conv-1","taskId":"req-1","timestamp":"...","session":{...},"platformHistoryCount":0}
{"type":"message","conversationId":"conv-1","taskId":"req-1","timestamp":"...","parentId":null,"message":{"id":"aaa","role":"user","content":"search for cats","timestamp":"..."}}
{"type":"message","conversationId":"conv-1","taskId":"req-1","timestamp":"...","parentId":"aaa","message":{"id":"bbb","role":"assistant","content":null,"timestamp":"...","toolCalls":[{"id":"call-1","type":"function","function":{"name":"web_search","arguments":"{\"q\":\"cats\"}"}}]}}
{"type":"message","conversationId":"conv-1","taskId":"req-1","timestamp":"...","parentId":"bbb","message":{"id":"ccc","role":"tool","content":"cats are great","timestamp":"...","toolCallId":"call-1","toolName":"web_search"}}
{"type":"message","conversationId":"conv-1","taskId":"req-1","timestamp":"...","parentId":"ccc","message":{"id":"ddd","role":"assistant","content":"Here's what I found about cats...","timestamp":"..."}}
{"type":"task_completed","conversationId":"conv-1","taskId":"req-1","timestamp":"...","finalText":"Here's what I found about cats...","completedTurns":2,"toolCallCount":1,"tokenUsage":{...},"session":{...}}
```

## Files to Change

### New Files

- `src/agent/transcript/types.ts` — entry type definitions, ArtifactRef
- `src/agent/transcript/TranscriptRecorder.ts` — unified recording with parentId chaining, dedup, sidechain routing, and loadTranscript (replaces RolloutRecorder)

### Modified Files

- `src/models/ModelClient.ts` — make `id` required (was optional), keep `timestamp` optional, add `generateId()` helper, add `synthetic?: boolean`. See "Prerequisite" section for details.
- `src/agent/SessionState.ts` — merge `canonicalHistory` + `promptHistory` into single `messages` array, add `appendMessages()`, `initializeFromTranscript()`, computed `getCanonicalHistory()` with synthetic message exclusion, remove `commitTask()` and `clonePromptMessage()`
- `src/agent/TurnExecutor.ts` — dual write (push to context + `recorder.recordMessage()`), push final assistant message to `context.messages`, record baseline length before user message, eliminate `promptMessages` assembly
- `src/agent/SessionRuntime.ts` — swap `IRolloutRecorder` → `ITranscriptRecorder`, use `appendMessages()` instead of `commitTask()`
- `src/agent/SessionManager.ts` — make `getOrCreateRuntime()` async, add transcript-load cold-start path: attempt `recorder.loadTranscript(conversationId)`, decide precedence vs platform history, initialize SessionState accordingly. See "Resume wiring" section below.
- `src/agent/types.ts` — `TurnExecutorDeps` gets `ITranscriptRecorder`, `TurnExecutionResult` drops `promptMessages` in favor of returning `newMessages: Message[]` directly
- `src/agent/subagent/SubagentTool.ts` — pass recorder for sidechain recording
- `src/agent/fork/ForkedAgent.ts` — stop discarding events, pass recorder for sidechain recording
- `src/agent/TurnContext.ts` — track `baselineLength` for slicing new messages after turn
- `src/agent/context/ToolResultPersistence.ts` — extend `processResult()` to return `ArtifactRef` alongside preview stub, for transcript artifact references
- Tests — update assertions to handle random UUIDs, update for new SessionState API

### Removed Files

- `src/agent/RolloutRecorder.ts` — replaced by TranscriptRecorder

## Dependency Injection

`TranscriptRecorder` is injected into `TurnExecutor` via `TurnExecutorDeps` (it's a stable construction-time dependency, not per-request state). `SessionRuntime` also receives it for lifecycle events. `SessionManager` also receives it for transcript loading on cold start. Forked agents and subagents use the same recorder instance — routing is internal.

## Resume Wiring in SessionManager

`SessionManager.getOrCreateRuntime()` is currently synchronous and constructs `SessionState` only from platform history (`submission.history`). For resume to work, this must become async with a cold-start path:

```typescript
// src/agent/SessionManager.ts (after refactor)

private async getOrCreateRuntime(submission: TurnSubmission): Promise<SessionRuntime> {
  const existing = this.sessions.get(submission.conversationId);
  if (existing) {
    return existing;
  }

  this.evictToCapacity();

  // Cold-start: attempt transcript load first
  let state: SessionState;
  const loaded = await this.transcriptRecorder
    .loadTranscript(submission.conversationId)
    .catch(() => null);  // transcript may not exist — that's fine

  if (loaded && loaded.messages.length > 0) {
    // Transcript exists — use it as the richer source
    state = new SessionState(submission.conversationId, []);
    state.initializeFromTranscript(loaded.messages);
    // Seed the recorder's parentId cursor so the next recordMessage() chains correctly
    if (loaded.leafId) {
      this.transcriptRecorder.seedParentId(submission.conversationId, loaded.leafId);
    }
    // Still reconcile with platform history to detect divergence
    state.reconcileWithPlatformHistory(submission.history);
  } else {
    // No transcript — initialize from platform history (existing behavior)
    state = new SessionState(submission.conversationId, submission.history);
  }

  const runtime = new SessionRuntime(state, { ... }, this.runtimeConfig);
  this.sessions.set(submission.conversationId, runtime);
  return runtime;
}
```

**Precedence rule:** Local transcript wins over platform history when both exist, because the transcript contains full tool-call detail that platform history strips. However, `reconcileWithPlatformHistory()` is still called after transcript load to detect if the platform has diverged (e.g., messages were deleted). If the platform history has diverged, the session is reseeded from platform history (matching today's behavior).

This also requires `SessionManager.execute()` to become async (it already awaits `runtime.execute()`, so the change is adding `await` to `getOrCreateRuntime()`).

## Implementation Sequence

### Step 1: Make `id` Required on Message

- Make `id` required in `Message` interface (was optional). Keep `timestamp` optional.
- Add `generateId()` convenience function to `src/models/ModelClient.ts`
- Add a `testMessage()` helper in test utils that auto-generates `id` to reduce fixture churn
- Fix any creation sites that don't set `id` (e.g., `compactHistory()` summary, SubagentTool `promptHistory`, test fixtures across TokenBudget, ToolResultPersistence, Microcompact, provider client tests, groupMessages, ReactiveCompact, etc.)
- `clonePromptMessage()` already copies `id` — verify
- Verify: all existing tests pass

### Step 2: Merge SessionState to One Array

- Replace `canonicalHistory` + `promptHistory` with single `messages: Message[]`
- Add `appendMessages(newMessages)` — replaces `commitTask()`
- Add `getCanonicalHistory()` as computed filter that excludes `synthetic` messages
- Mark `compactHistory()` summary message with `synthetic: true` so it doesn't leak into canonical view (today `compactHistory()` replaces `promptHistory` but leaves `canonicalHistory` untouched — the `synthetic` flag preserves this separation in the merged array)
- Add `initializeFromTranscript(messages)` for future resume
- Update `reconcileWithPlatformHistory()` to work with single array
- Update `SessionRuntime.commitResult()` to use `appendMessages()`
- Eliminate `promptMessages` from `TurnExecutionResult` — `TurnExecutor` returns new messages via `context.messages.slice(baselineLength)` directly
- Fix all tests
- Verify: existing behavior unchanged

### Step 3: Types and TranscriptRecorder

- Create `src/agent/transcript/types.ts` with entry definitions
- Create `src/agent/transcript/TranscriptRecorder.ts`
  - Same JSONL append pattern as RolloutRecorder
  - Write queue for ordering
  - `recordMessage()` for inline per-message recording with automatic parentId tracking (per-conversation `lastParentId` map)
  - `recordLifecycleEvent()` for non-chain entries
  - `insertMessageChain()` for batch recording (sidechains, initial history)
  - Two-layer UUID dedup (messageSet loaded from JSONL on first access, updated in-memory)
  - Sidechain routing based on `isSidechain` + `agentId`
- Update `SessionRuntime` to use TranscriptRecorder for lifecycle events
- Delete `RolloutRecorder.ts`
- Verify: existing rollout tests pass with new recorder

### Step 4: Dual Write in TurnExecutor

- Add `ITranscriptRecorder` to `TurnExecutorDeps`
- At each `context.messages.push()` site, add corresponding `recorder.recordMessage()` call:
  - **User message** (after recording baseline length, before LLM call):
    `context.messages.push(userMsg)` + `recorder.recordMessage(convId, userMsg, { taskId, turnId })`
  - **Assistant tool-call messages** (after LLM returns tool_calls):
    `context.messages.push(assistantMsg)` + `recorder.recordMessage(convId, assistantMsg, { taskId, turnId })`
  - **Tool result messages** (after tool execution):
    `context.messages.push(toolMsg)` + `recorder.recordMessage(convId, toolMsg, { taskId, turnId, parentOverride: assistantMsg.id })`
    Note: `parentOverride` points tool results back to the spawning assistant message, creating the DAG for parallel tool calls
  - **Final assistant text message** (after LLM returns final_text):
    `context.messages.push(finalMsg)` + `recorder.recordMessage(convId, finalMsg, { taskId, turnId })`
- The recorder maintains `lastParentId` per conversation internally — callers only pass `parentOverride` for the tool-result→assistant DAG link
- Verify: JSONL now contains full message history, in-memory history unchanged

### Step 5: Forked Agent and Subagent Transcripts

- Update ForkedAgent to pass messages through recorder with `isSidechain=true` and an `agentId`
- Update SubagentTool to record sidechain transcripts
- Support `skipTranscript` for ephemeral forks
- Verify: agent transcripts appear in `<conv-hash>/subagents/`

### Step 6: Transcript-Aware Content Externalization

`ToolResultPersistence` already handles externalization with per-tool and per-message budgets. However, its `enforceMessageBudget()` currently runs inside `prepareContextForModelCall()` at the **top of the next model loop iteration** — after the tool result message has already been pushed and recorded. This means the transcript would record the full oversized content, and the LLM would see the externalized preview, creating an inconsistency.

**Fix: move per-tool externalization before recording.** Call `ToolResultPersistence.processResult()` on each tool result **immediately after tool execution**, before pushing to `context.messages` and before `recordMessage()`. This way both the in-memory message and the transcript entry contain the preview stub (or the original if under threshold). The per-message aggregate budget enforcement (`enforceMessageBudget()`) stays in `prepareContextForModelCall()` as a second pass.

- Extend `ToolResultPersistence.processResult()` to return `{ content, artifactRef? }` instead of just the content string
- When `processResult()` externalizes content, the returned `ArtifactRef` contains the file path, original size, and preview
- In TurnExecutor, **after tool execution but before push+record**:
  1. Call `toolResultPersistence.processResult(toolName, callId, content, conversationId)`
  2. Use the returned `content` (preview or original) for the tool message pushed to `context.messages`
  3. Attach the `artifactRef` (if any) when calling `recorder.recordMessage()`
- `prepareContextForModelCall()` still runs `enforceMessageBudget()` as a safety net for aggregate limits, but individual large results are already handled
- Remove the 2000-char truncation from sanitizeData — externalization replaces it

### Step 7: Resume from Transcript

Claudy's `loadConversationForResume()` (in `conversationRecovery.ts`) handles numerous edge cases. Our implementation should cover these:

#### 7a. Core: Load and rebuild conversation chain

- Implement `loadTranscript(conversationId)`:
  1. Parse JSONL into `Map<UUID, MessageEntry>` for O(1) lookups
  2. **Find the leaf:** Identify the newest non-sidechain `MessageEntry` that is not referenced as any other entry's `parentId` (it's a leaf in the DAG). This is the resume point.
  3. **Walk backwards:** From the leaf, follow `parentId` links to the root (`parentId: null`), collecting entries into an array
  4. **Cycle detection:** Track a `seen: Set<UUID>` during the walk. If a UUID is encountered twice, log an error and break — corrupted transcript should not infinite-loop
  5. **Reverse** the collected array to get root→leaf chronological order
  6. Strip transcript metadata (`parentId`, `isSidechain`, `agentId`), return `Message[]`
- Wire into `SessionState.initializeFromTranscript()`

#### 7b. Orphaned parallel tool result recovery

When an assistant message spawns multiple parallel tool calls, each tool result points back to the same assistant `parentId`. A naive backwards walk from the leaf only follows one path and misses sibling tool results.

After the initial chain walk, scan all entries in the `Map` for any `MessageEntry` whose `parentId` matches an assistant message in the recovered chain but which was NOT visited. Insert these orphaned siblings at the correct position (after their shared parent). This reconstructs the full DAG from a single-parent walk. (Claudy calls this `recoverOrphanedParallelToolResults()`.)

#### 7c. Filter unresolved tool uses

If the agent crashed mid-turn, the transcript may contain an assistant message with `toolCalls` but no corresponding tool result entries. These incomplete tool calls will confuse the LLM on resume.

After rebuilding the chain, scan for assistant messages with `toolCalls` where one or more `toolCallId` has no matching tool result message. Remove these unresolved assistant messages from the recovered array. (Claudy calls this `filterUnresolvedToolUses()`.)

#### 7d. Interrupted turn detection

If the last entry in the recovered chain is a user message with no subsequent assistant response, the previous turn was interrupted. Append a synthetic user message: `{ role: 'user', content: 'Continue from where you left off.' }` so the LLM knows to resume rather than re-process.

#### 7e. Safety and retention

- Add max file size check for read safety (skip resume if JSONL exceeds threshold, e.g. 50MB)
- Define retention policy (e.g., max age 30 days, max total size per conversation)

## Testing Strategy

- **Unit:** TranscriptRecorder writes valid JSONL, entries roundtrip through JSON.parse
- **Unit:** UUID dedup — two-layer: caller filters + recorder double-checks
- **Unit:** parentId assignment — linear chain and tool-result DAG cases
- **Unit:** Sidechain routing — main vs. agent file selection
- **Unit:** ToolResultPersistence returns ArtifactRef when externalizing, transcript records artifact references
- **Unit:** SessionState single-array — appendMessages, getCanonicalHistory computed view, reconciliation
- **Integration:** TurnExecutor dual write — in-memory and JSONL both contain correct messages
- **Integration:** Large tool results get externalized, transcript has artifact refs
- **Integration:** Forked agent produces sidechain transcript
- **Integration:** Resume from transcript — load JSONL → initialize SessionState → next turn works
- **Unit:** Resume leaf-finding — newest non-sidechain message selected as resume point
- **Unit:** Resume cycle detection — corrupted parentId loop terminates gracefully
- **Unit:** Orphaned parallel tool result recovery — sibling tool results from same assistant message all recovered
- **Unit:** Unresolved tool use filtering — assistant messages with missing tool results removed
- **Unit:** Interrupted turn detection — synthetic continuation appended when last message is user
- **Edge cases:** Concurrent writes ordered correctly, abort mid-turn leaves valid partial JSONL

## Risks

- Recording every message increases I/O — mitigate with async append (already queued)
- Large transcripts on long conversations — mitigate with artifact externalization
- Breaking existing rollout consumers — mitigate by keeping same file location, superset schema
- Making `id` required touches many test fixtures — mitigate with a `testMessage()` helper that auto-generates `id` and `timestamp`
- messageSet memory on very long conversations — mitigate with read safety limits
- SessionState refactor touches many call sites — mitigate by doing it as a separate step (Step 2) before adding transcript
- Resume from corrupted transcript — mitigate with cycle detection, unresolved tool use filtering, and max file size check
- Parallel tool result recovery adds complexity to chain rebuild — mitigate with focused unit tests on DAG reconstruction

## Success Criteria

- Single in-memory `messages` array replaces the three-array split
- Dual write: every message persisted to JSONL inline during the turn
- Full request execution reconstructable from transcript JSONL alone
- Tool call arguments and results recoverable (inline or via artifact)
- No data loss on session eviction — transcript is on disk
- Resume from transcript works — JSONL → in-memory messages → next turn
- Transcript file stays bounded (large content externalized)
- Messages have required `id` field (stable UUID) enabling dedup and chain/resume support
- parentId chain enables conversation tree reconstruction
- Forked agent and subagent histories recorded in sidechain files
- Existing lifecycle events still present for backward compatibility
- Resume handles edge cases: parallel tool results, unresolved tool uses, interrupted turns, cycle detection
- Per-tool and per-message externalization limits enforced (global budget deferred to future config addition if needed)
- Lifecycle entries do not advance the parentId chain (non-chain participants)
- Write queue batches I/O with configurable flush interval and max chunk size
- Agent metadata sidecar written alongside sidechain transcripts for sub-agent resume

## Design Decisions

### Platform history vs local transcript precedence

When a session is evicted (30-min TTL) and a new task arrives for the same conversation, both the platform-supplied history and a local transcript may exist. **Local transcript wins** because it contains full tool-call detail that platform history strips to user/assistant text pairs. However, `reconcileWithPlatformHistory()` is still called after transcript load to detect divergence — if the platform history has changed (e.g., messages were deleted or the conversation was reset), the session reseeds from platform history, discarding the local transcript. This matches the existing "platform owns truth" principle while preserving richer local data when available.

### System prompt exclusion mechanism

System prompts are excluded from the transcript via the **slicing mechanism**, not by filtering on role. The system prompt is part of `initialMessages` (before the baseline index), so `context.messages.slice(baselineLength)` naturally excludes it. For subagents, the system prompt is passed via `promptHistory` which also lands in `initialMessages` — same exclusion. All messages (including system prompts) still need `id` and `timestamp` for the in-memory array, even though system messages are not transcribed. The "UUID assignment sites" in the prerequisite section lists SubagentTool because those messages need IDs for the in-memory array, not because they'll be recorded.
