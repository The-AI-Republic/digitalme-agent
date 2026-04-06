# Transcript and Artifact Storage

## Goal

Persist a richer internal execution record than the platform-visible message history.

This track should make `digitalme-agent` better at:

- debugging production behavior
- reconstructing request execution history
- restoring continuity after restart or reseed
- externalizing large prompt/tool artifacts safely

## Current State

Today the main internal persistence mechanism is:

- `src/agent/RolloutRecorder.ts`

That gives useful JSONL rollout traces, but it is not yet a transcript-grade storage model.

## Claudy Patterns Worth Borrowing

Relevant source references:

- `/home/rich/dev/study/claudy/src/utils/sessionStorage.ts`
- `/home/rich/dev/study/claudy/src/types/logs.ts`
- `/home/rich/dev/study/claudy/src/utils/toolResultStorage.ts`

Important patterns:

- append-only JSONL
- multiple entry types, not one single event blob
- persisted vs ephemeral distinction
- externalized content replacement records
- transcript read safety / OOM protections
- sidecar metadata when useful

## Target Design for DigitalMe Agent

### New Modules

- `src/agent/TurnTranscriptRecorder.ts`
  - transcript-grade request records
- `src/agent/ArtifactStore.ts`
  - store large tool outputs, prompt snapshots, and other large runtime artifacts
- `src/agent/types/artifacts.ts`
  - transcript and artifact metadata

### Existing Files To Change

- `src/agent/SessionRuntime.ts`
- `src/agent/TurnExecutor.ts`
- `src/agent/RolloutRecorder.ts`

## Format Choice

Use append-only JSONL for transcript-grade storage.

Reasons:

- line-oriented
- streaming-friendly
- easy to inspect locally
- easier partial recovery than large monolithic JSON

## Suggested Entry Categories

### Persisted Entries

- request started
- request completed
- request failed
- prompt projection snapshot
- token usage
- tool executed
- tool result externalized
- tool-use summary stored
- continuation reason
- terminal reason
- summary memory updated

### Ephemeral Entries

- per-chunk streaming status
- transient progress indicators
- UI-only state
- noisy low-value execution ticks

Ephemeral entries should not be written to transcript-grade storage.

## Artifact Store Use Cases

Use `ArtifactStore` for:

- large tool results
- prompt snapshots
- overflow/debug dumps if needed
- summary memory snapshots when auditing behavior

The transcript should store references to artifacts, not duplicate large contents inline.

## Suggested Implementation Sequence

### Step 1: Transcript Schema

Files:

- new `src/agent/types/artifacts.ts`
- new `src/agent/TurnTranscriptRecorder.ts`

Work:

- define transcript entry union
- separate persisted from ephemeral entry types

### Step 2: Hook into SessionRuntime and TurnExecutor

Files:

- `src/agent/SessionRuntime.ts`
- `src/agent/TurnExecutor.ts`

Work:

- record request lifecycle
- record per-request metadata
- record continuation and terminal reasons

### Step 3: Add ArtifactStore

Files:

- new `src/agent/ArtifactStore.ts`
- `src/agent/TurnTranscriptRecorder.ts`

Work:

- externalize oversized tool outputs
- persist prompt snapshots when useful
- write references into JSONL

### Step 4: Read Safety and Resume Safety

Work:

- define transcript read size limits
- define retention expectations
- make artifact references stable enough for resume/reseed workflows

## Testing Strategy

Add tests for:

- JSONL entry writing
- artifact reference creation
- large output externalization
- persisted-vs-ephemeral filtering
- transcript read safety on large files

## Risks

- storing too much too early
- making transcript format too broad before use cases are clear
- retaining raw large payloads inline and defeating the whole design

## Success Criteria

- request execution can be reconstructed from internal records
- large artifacts are externalized safely
- transcript storage remains append-only and bounded

