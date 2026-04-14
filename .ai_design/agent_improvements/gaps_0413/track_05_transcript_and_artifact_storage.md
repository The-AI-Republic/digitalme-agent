# Track 05: Transcript and Artifact Storage -- Gap Analysis

## Summary

The implementation is substantially complete across all 12 phases. Most core features are fully implemented. There are a few stale test files referencing deleted modules and a missing transcript retention policy.

---

## Phase 1: Message Identity

| Item | Status | Notes |
|------|--------|-------|
| `generateId()` in ModelClient.ts | YES | `crypto.randomUUID()` |
| `Message.id` required | YES | Deviation from optional -- improvement |
| `Message.timestamp` optional | YES | |
| `Message.synthetic` optional | YES | |
| Provider clients ignore extra fields | YES | |

**Status: COMPLETE**

---

## Phase 2: Single Session Message Array

| Item | Status | Notes |
|------|--------|-------|
| Replace dual history with one `messages` array | YES | |
| `getCanonicalHistory()` as computed view | YES | Filters out toolCalls, synthetic |
| `appendMessages(newMessages)` | YES | Also accepts optional `toolSummaries` |
| `TurnExecutionResult.newMessages` | YES | |

**Status: COMPLETE**

---

## Phase 3: TurnExecutor New Message Lifecycle

| Item | Status | Notes |
|------|--------|-------|
| `baselineLength` recorded before user message | YES | |
| All messages have `id` and `timestamp` | YES | |
| `newMessages = context.messages.slice(baselineLength)` | YES | |

**Concern:** `prepareContextForModelCall` replaces `context.messages` in-place (`context.messages.length = 0; push(...)`) but does NOT recalculate `baselineLength`. Safe in practice since context prep doesn't remove messages, but no test covers this edge case.

**Status: YES (with minor concern)**

---

## Phase 4: Transcript Types and Recorder

| Item | Status | Notes |
|------|--------|-------|
| All transcript entry types | YES | Includes fork/subagent/hook/compact types beyond spec |
| `TranscriptRecorder` with write queues | YES | 100ms flush, 100MB chunks |
| Per-conversation hashed file naming | YES | SHA-256, 16-char prefix |
| Append-only JSONL | YES | |
| `recordMessage()` with parentId chaining | YES | |
| Lifecycle events don't advance parent chain | YES | |
| Two-layer dedup | YES | Caller-side and recorder-side |
| Sidechain routing | YES | `subagents/agent-<agentId>.jsonl` |
| Remove `RolloutRecorder.ts` | YES | Deleted |

**Bug:** `src/agent/RolloutRecorder.test.ts` still exists, imports deleted module.

**Bug:** `src/agent/SessionRuntime.test.ts` still imports `RolloutEntry` from `./RolloutRecorder.js`.

**Status: YES (with stale test files)**

---

## Phase 5-7: Lifecycle Recording, Dual Write, Tool Result Persistence

All fully implemented:
- SessionRuntime uses `ITranscriptRecorder` for lifecycle events
- TurnExecutor records user, assistant, tool messages inline
- `processResultWithRef()` returns `ArtifactRef` for large results
- System prompts correctly excluded from transcript

**Status: COMPLETE**

---

## Phase 8-9: Resume from Transcript + SessionManager Wiring

| Item | Status | Notes |
|------|--------|-------|
| `loadTranscript()` | YES | Full implementation with cycle detection, orphan recovery |
| Max file size check (50MB) | YES | |
| Cold start transcript resume | YES | |
| Platform history reconciliation after resume | YES | |

**Status: COMPLETE**

---

## Phase 10: Forked Agent and Subagent Sidechains

Fully implemented with `isSidechain: true` routing, agent metadata persistence, and main transcript isolation.

**Status: COMPLETE**

---

## Phase 11: Retention and Cleanup

| Item | Status | Notes |
|------|--------|-------|
| Max transcript read size | YES | 50MB guard |
| Retention policy (max age, max total size) | **NO** | Not implemented. Transcripts grow unbounded. |
| Cleanup does not delete durable transcripts | YES | Only cleans tool-result storage |

**Status: PARTIAL**

---

## Issues Requiring Attention

### Blocking

1. **Stale `RolloutRecorder.test.ts`** -- imports deleted module, will fail tests. Should be deleted.
2. **Stale import in `SessionRuntime.test.ts`** -- imports `RolloutEntry` from deleted `RolloutRecorder.js`. Must be migrated.

### Non-Blocking

3. No shared `testMessage()` helper (each test rolls its own).
4. No transcript retention policy -- files grow unbounded.
5. No test for `baselineLength` safety after context rewrite.

### Notable Additions Beyond Design

- Additional lifecycle entry types (fork/subagent/hook/compact)
- `writeAgentMetadata()` on `ITranscriptRecorder`
- `toolSummaries` on `appendMessages()`
