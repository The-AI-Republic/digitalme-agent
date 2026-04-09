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

**Problem:** Three arrays holding overlapping data is unnecessary complexity. Claudy uses a single `messages` array. `canonicalHistory` is derivable by filtering the full history.

**Change:** Merge into one `SessionState.messages: Message[]` array. `canonicalHistory` becomes a computed view (filter for user/assistant messages without tool metadata). `context.messages` stays as the per-turn working copy — claudy also has a per-turn copy passed to the API.

### Dual Write (missing — needs to be added)

Claudy does dual write at each message production site:
1. Push to in-memory messages array (for the next LLM turn)
2. Record to disk transcript (for persistence/resume)

Our agent currently only does #1. No message content hits disk. The `promptMessages` batch returned from `TurnExecutor.run()` feeds the in-memory history but is not persisted.

**Change:** Add inline disk recording alongside each `context.messages.push()` call in `TurnExecutor`. Two operations, same call site. Eliminate the `promptMessages` batch — after the turn, append the new messages from `context.messages` directly to `SessionState.messages`.

### On-Disk Persistence (lifecycle summaries only → full transcript)

Today the only disk persistence is `RolloutRecorder.ts` with 4 lifecycle event types (`task_started`, `task_completed`, `task_failed`, `session_reseeded`). No message content is recorded.

**Change:** Replace with `TranscriptRecorder` that records every message inline during the turn, plus lifecycle events.

### Resume (not possible → load from transcript)

Today, when a session is evicted from memory (30 min TTL), the full execution detail is lost forever. There is no resume capability.

**Change:** Add `loadTranscript()` that reads the JSONL, rebuilds the conversation chain via `parentUuid`, strips transcript metadata, and returns `Message[]` to initialize `SessionState.messages`. This enables resume after eviction.

## Prerequisite: Add UUID to Message

The `Message` interface (`src/models/ModelClient.ts`) currently has no identity field. Every message needs a stable UUID for:

- **Dedup on write:** two-layer dedup (caller filters + recorder double-checks) prevents re-recording history messages on resume/replay
- **Conversation chain:** `parentUuid` linking enables reconstructing the conversation tree
- **Artifact references:** externalized content is keyed by message/tool-call identity

### Change to Message interface

```typescript
// src/models/ModelClient.ts
import crypto from 'node:crypto';

export function generateUuid(): string {
  return crypto.randomUUID();
}

export interface Message {
  uuid: string;  // stable identity for transcript dedup and chaining
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}
```

### UUID assignment sites

Every place that creates a `Message` must call `generateUuid()`:

- `TurnExecutor.run()` — user message, assistant messages (tool-call and final), tool result messages
- `SessionState` — when converting `HistoryMessage[]` to `Message[]` (platform history seeding)
- `SessionState.compactHistory()` — the summary message
- `SubagentTool` — system and user prompt messages

### Impact on existing code

- `SessionState.clonePromptMessage()` — must copy `uuid`
- Model clients (Anthropic, OpenAI, Google) — uuid is ignored when building API requests (it's internal metadata, not sent to providers)
- Tests using `deepEqual` on messages — need to either use a `stripUuids()` helper or assert on role/content individually since UUIDs are random

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
    → loadTranscript() parses, walks parentUuid chain
    → strips transcript metadata (parentUuid, isSidechain, agentId)
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

  /** Canonical view for platform reconciliation — computed, not stored */
  getCanonicalHistory(): HistoryMessage[] {
    return this.messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.toolCalls)
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

After refactor:
- `TurnExecutor.run()` still returns `TurnExecutionResult`, but `promptMessages` is replaced by the new messages produced during the turn (available as `context.messages.slice(initialMessages.length)`)
- `SessionRuntime` calls `SessionState.appendMessages(newMessages)` instead of `commitTask(userMessage, finalText, promptMessages)`
- The user message is included as the first new message, the final assistant message as the last — no re-assembly needed

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
 * parentUuid is assigned by the recorder, not the caller.
 */
interface MessageEntry extends TranscriptEntry {
  type: 'message';
  parentUuid: string | null;  // assigned by recorder during insertMessageChain
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

### parentUuid Chaining

Following claudy, `parentUuid` is assigned by the recorder, not the caller:

- The recorder tracks a running `parentUuid` variable as it processes a chain of messages
- First message in a chain gets `parentUuid: null` (or a hint from the caller for continuation)
- Each subsequent message points to the previous message's UUID
- For tool results: the caller sets `sourceAssistantUuid` on the Message, and the recorder uses that as an override — so tool results point to the assistant that spawned the tool call, not the sequential previous message

This creates a DAG (not a linear chain) when parallel tool calls produce multiple tool results from a single assistant message.

### Dedup: Two-Layer, Rebuilt from Disk

Following claudy's proven pattern:

**Layer 1 (Caller-side):** Before calling `insertMessageChain()`, the caller filters messages against a `messageSet` of already-recorded UUIDs. Only new messages are passed to the recorder.

**Layer 2 (Recorder-side):** `appendEntry()` double-checks `messageSet.has(entry.uuid)` before writing. Belt-and-suspenders safety.

**The `messageSet`:**
- Loaded from the JSONL on first access (memoized per conversation)
- Updated in-memory as entries are written (`messageSet.add(entry.uuid)`)
- Cleared after compaction (if/when we add compaction)
- On restart: rebuilt from JSONL on first access

This is needed because sessions can be resumed from transcript after the 30-min TTL eviction, and the transcript may already contain messages that the resumed session would re-encounter.

### TranscriptRecorder

```typescript
// src/agent/transcript/TranscriptRecorder.ts

interface ITranscriptRecorder {
  /** Record any transcript entry (message or lifecycle event) */
  record(entry: TranscriptEntry): Promise<void>;
  /** Record a chain of messages with parentUuid assignment and dedup */
  insertMessageChain(
    messages: Message[],
    isSidechain?: boolean,
    agentId?: string,
    startingParentUuid?: string | null,
  ): Promise<void>;
  /** Load transcript and rebuild conversation chain for resume */
  loadTranscript(conversationId: string): Promise<Message[]>;
}
```

Single recorder instance handles routing for main transcript and agent sidechains.

Implementation:
- Same append-only JSONL as RolloutRecorder (proven pattern, keep it)
- Same write-queue for concurrency safety
- Per-conversation file naming (same hash scheme)
- `insertMessageChain()` assigns `parentUuid` and performs UUID dedup
- Routes entries based on `isSidechain` + `agentId` fields:
  - If both set → write to `<conv-hash>/subagents/agent-<agentId>.jsonl`
  - Otherwise → write to `<conv-hash>.jsonl`
- Agent transcript files created lazily on first write
- `loadTranscript()` parses JSONL, walks `parentUuid` chain, strips transcript metadata, returns `Message[]`

### Forked Agent and Subagent Transcripts

Following claudy, forked agents and subagents are treated identically at the transcript level. Each gets its own JSONL file under `subagents/`:

```
.digital_me_agent/rollouts/
  <conv-hash>.jsonl                              ← main transcript
  <conv-hash>/
    subagents/
      agent-<agentId>.jsonl                      ← agent's full internal history
    artifacts/<toolCallId>.txt                   ← externalized content
```

The main transcript only sees the `tool_use` → `tool_result` pair (the agent's summarized output). The agent's internal conversation (its tool calls, results, intermediate reasoning) goes into its sidechain file.

Routing is in the recorder (`appendEntry` checks `isSidechain && agentId`), not per-agent instances. The `isSidechain` and `agentId` fields are stamped onto entries at write time, not on in-memory `Message` objects.

Ephemeral forks (e.g., internal work that doesn't need audit) can pass `agentId = undefined` to skip transcript recording entirely (matches claudy's `skipTranscript` pattern).

### Artifact Store

Externalization of large content happens in the **execution layer** (TurnExecutor), not the recording layer. The recorder stays dumb — it just appends what it's given.

```typescript
// src/agent/transcript/ArtifactStore.ts

interface IArtifactStore {
  /** Store content, return artifact ref */
  store(conversationId: string, toolCallId: string, content: string): Promise<ArtifactRef>;
}

interface ArtifactRef {
  artifactId: string;
  filePath: string;
  originalSize: number;
  preview: string; // first 2KB
}
```

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
- System prompt — derivable from config
- `AgentEvent` stream (text_delta, tool_start, tool_end, done) — ephemeral UI events
- Re-played history messages — dedup by UUID prevents this

### Example Transcript Output

After one turn with a tool call, the JSONL looks like:

```jsonl
{"type":"task_started","conversationId":"conv-1","taskId":"req-1","timestamp":"...","session":{...},"platformHistoryCount":0}
{"type":"message","conversationId":"conv-1","taskId":"req-1","timestamp":"...","parentUuid":null,"message":{"uuid":"aaa","role":"user","content":"search for cats"}}
{"type":"message","conversationId":"conv-1","taskId":"req-1","timestamp":"...","parentUuid":"aaa","message":{"uuid":"bbb","role":"assistant","content":null,"toolCalls":[{"id":"call-1","type":"function","function":{"name":"web_search","arguments":"{\"q\":\"cats\"}"}}]}}
{"type":"message","conversationId":"conv-1","taskId":"req-1","timestamp":"...","parentUuid":"bbb","message":{"uuid":"ccc","role":"tool","content":"cats are great","toolCallId":"call-1","toolName":"web_search"}}
{"type":"message","conversationId":"conv-1","taskId":"req-1","timestamp":"...","parentUuid":"ccc","message":{"uuid":"ddd","role":"assistant","content":"Here's what I found about cats..."}}
{"type":"task_completed","conversationId":"conv-1","taskId":"req-1","timestamp":"...","finalText":"Here's what I found about cats...","completedTurns":2,"toolCallCount":1,"tokenUsage":{...},"session":{...}}
```

## Files to Change

### New Files

- `src/agent/transcript/types.ts` — entry type definitions, ArtifactRef
- `src/agent/transcript/TranscriptRecorder.ts` — unified recording with parentUuid chaining, dedup, sidechain routing, and loadTranscript (replaces RolloutRecorder)
- `src/agent/transcript/ArtifactStore.ts` — large content externalization

### Modified Files

- `src/models/ModelClient.ts` — add `uuid` field to `Message`, add `generateUuid()`
- `src/agent/SessionState.ts` — merge `canonicalHistory` + `promptHistory` into single `messages` array, add `appendMessages()`, `initializeFromTranscript()`, computed `getCanonicalHistory()`, remove `commitTask()` and `clonePromptMessage()`
- `src/agent/TurnExecutor.ts` — generate UUIDs at message creation, dual write (push to context + record to JSONL), eliminate `promptMessages` assembly
- `src/agent/SessionRuntime.ts` — swap `IRolloutRecorder` → `ITranscriptRecorder`, use `appendMessages()` instead of `commitTask()`
- `src/agent/types.ts` — `TurnExecutorDeps` gets `ITranscriptRecorder`, `TurnExecutionResult` drops `promptMessages` in favor of returning new messages directly
- `src/agent/subagent/SubagentTool.ts` — generate UUIDs, pass recorder for sidechain recording
- `src/agent/fork/ForkedAgent.ts` — stop discarding events, pass recorder for sidechain recording
- `src/agent/TurnContext.ts` — track `initialMessagesLength` for slicing new messages after turn
- Tests — update assertions to handle random UUIDs, update for new SessionState API

### Removed Files

- `src/agent/RolloutRecorder.ts` — replaced by TranscriptRecorder

## Dependency Injection

`TranscriptRecorder` is injected into `TurnExecutor` via `TurnExecutorDeps` (it's a stable construction-time dependency, not per-request state). `SessionRuntime` also receives it for lifecycle events. Forked agents and subagents use the same recorder instance — routing is internal.

## Implementation Sequence

### Step 1: Add UUID to Message

- Add `uuid: string` and `generateUuid()` to `src/models/ModelClient.ts`
- Update all Message creation sites to generate UUIDs
- Update `SessionState.clonePromptMessage()` to preserve UUID
- Fix test assertions
- Verify: all existing tests pass

### Step 2: Merge SessionState to One Array

- Replace `canonicalHistory` + `promptHistory` with single `messages: Message[]`
- Add `appendMessages(newMessages)` — replaces `commitTask()`
- Add `getCanonicalHistory()` as computed filter
- Add `initializeFromTranscript(messages)` for future resume
- Update `reconcileWithPlatformHistory()` to work with single array
- Update `SessionRuntime.commitResult()` to use `appendMessages()`
- Eliminate `promptMessages` from `TurnExecutionResult` — `TurnExecutor` returns new messages via `context.messages.slice(initialMessagesLength)` directly
- Fix all tests
- Verify: existing behavior unchanged

### Step 3: Types and TranscriptRecorder

- Create `src/agent/transcript/types.ts` with entry definitions
- Create `src/agent/transcript/TranscriptRecorder.ts`
  - Same JSONL append pattern as RolloutRecorder
  - Write queue for ordering
  - `insertMessageChain()` with parentUuid assignment
  - Two-layer UUID dedup (messageSet loaded from JSONL on first access, updated in-memory)
  - Sidechain routing based on `isSidechain` + `agentId`
- Update `SessionRuntime` to use TranscriptRecorder for lifecycle events
- Delete `RolloutRecorder.ts`
- Verify: existing rollout tests pass with new recorder

### Step 4: Dual Write in TurnExecutor

- Add `ITranscriptRecorder` to `TurnExecutorDeps`
- At each `context.messages.push()` site, add corresponding `recorder.record()` call
  - User message (before LLM call)
  - Assistant tool-call messages (after LLM returns tool_calls)
  - Tool result messages (after tool execution)
  - Final assistant text message (after LLM returns final_text)
- Verify: JSONL now contains full message history, in-memory history unchanged

### Step 5: Forked Agent and Subagent Transcripts

- Update ForkedAgent to pass messages through recorder with `isSidechain=true` and an `agentId`
- Update SubagentTool to record sidechain transcripts
- Support `skipTranscript` for ephemeral forks
- Verify: agent transcripts appear in `<conv-hash>/subagents/`

### Step 6: Artifact Store and Content Externalization

- Create `src/agent/transcript/ArtifactStore.ts`
- In TurnExecutor, before recording a tool result message:
  - Check content size against threshold (50KB default)
  - If over: store via ArtifactStore, attach `artifactRef` to the MessageEntry, replace inline content with preview
- Remove the 2000-char truncation from sanitizeData — externalization replaces it

### Step 7: Resume from Transcript

- Implement `loadTranscript(conversationId)` — parse JSONL, walk parentUuid chain, strip metadata, return `Message[]`
- Wire into `SessionState.initializeFromTranscript()`
- Add max file size check for read safety
- Define retention policy (e.g., max age, max total size)

## Testing Strategy

- **Unit:** TranscriptRecorder writes valid JSONL, entries roundtrip through JSON.parse
- **Unit:** UUID dedup — two-layer: caller filters + recorder double-checks
- **Unit:** parentUuid assignment — linear chain and tool-result DAG cases
- **Unit:** Sidechain routing — main vs. agent file selection
- **Unit:** ArtifactStore writes files, generates stable IDs
- **Unit:** SessionState single-array — appendMessages, getCanonicalHistory computed view, reconciliation
- **Integration:** TurnExecutor dual write — in-memory and JSONL both contain correct messages
- **Integration:** Large tool results get externalized, transcript has artifact refs
- **Integration:** Forked agent produces sidechain transcript
- **Integration:** Resume from transcript — load JSONL → initialize SessionState → next turn works
- **Edge cases:** Concurrent writes ordered correctly, abort mid-turn leaves valid partial JSONL

## Risks

- Recording every message increases I/O — mitigate with async append (already queued)
- Large transcripts on long conversations — mitigate with artifact externalization
- Breaking existing rollout consumers — mitigate by keeping same file location, superset schema
- UUID overhead on Message — minimal (one string field), but touches many creation sites
- messageSet memory on very long conversations — mitigate with read safety limits
- SessionState refactor touches many call sites — mitigate by doing it as a separate step (Step 2) before adding transcript

## Success Criteria

- Single in-memory `messages` array replaces the three-array split
- Dual write: every message persisted to JSONL inline during the turn
- Full request execution reconstructable from transcript JSONL alone
- Tool call arguments and results recoverable (inline or via artifact)
- No data loss on session eviction — transcript is on disk
- Resume from transcript works — JSONL → in-memory messages → next turn
- Transcript file stays bounded (large content externalized)
- Messages have stable UUIDs enabling dedup and chain/resume support
- parentUuid chain enables conversation tree reconstruction
- Forked agent and subagent histories recorded in sidechain files
- Existing lifecycle events still present for backward compatibility
