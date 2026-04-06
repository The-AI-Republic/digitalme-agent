# DigitalMe Agent Runtime Improvement Plan

## Purpose

This plan turns the architectural memo into a concrete implementation sequence for `digitalme-agent`.

Detailed per-sector plans live in:

- `01_prompt_management/IMPLEMENTATION_PLAN.md`
- `02_context_management/IMPLEMENTATION_PLAN.md`
- `03_tool_runtime/IMPLEMENTATION_PLAN.md`
- `04_recovery_and_continuation/IMPLEMENTATION_PLAN.md`
- `05_transcript_and_artifact_storage/IMPLEMENTATION_PLAN.md`
- `06_runtime_state_and_observers/IMPLEMENTATION_PLAN.md`
- `07_internal_events_and_observability/IMPLEMENTATION_PLAN.md`

It assumes:

- the current core runtime shape is correct
- the current request loop in `TurnExecutor.ts` should remain the center of execution
- improvements should harden and extend the current design rather than replace it

## Guiding Rules

- preserve the current platform protocol
- preserve per-conversation FIFO behavior
- preserve the current request-driven runtime shape
- add internal runtime structure only when it improves safety, observability, or prompt correctness
- keep new abstractions close to current files at first; avoid large-scale package reshuffling

## Current Runtime Baseline

Today the main runtime path is:

1. HTTP ingress in `src/routes/turns.ts`
2. request admission in `src/agent/Agent.ts`
3. queueing in `src/agent/SubmissionQueue.ts`
4. session lookup and lifecycle in `src/agent/SessionManager.ts`
5. per-conversation execution in `src/agent/SessionRuntime.ts`
6. history state in `src/agent/SessionState.ts`
7. turn loop in `src/agent/TurnExecutor.ts`
8. tool lookup in `src/tools/registry.ts`

This plan builds on that flow.

## Target Additions

The runtime improvements are organized into seven additions:

1. prompt management and composition
2. context management, projection, and compaction
3. stronger tool runtime and policy hooks
4. explicit recovery and continuation behavior
5. richer internal transcript and artifacts
6. explicit runtime state and observers
7. richer internal event taxonomy

## Proposed Module Additions

These modules should be added incrementally.

### Prompt Management

- `src/prompts/SystemPromptBuilder.ts`
  - assemble model-facing system prompts from stable sections and runtime appends
- `src/prompts/PromptSections.ts`
  - hold reusable prompt section builders
- `src/prompts/PromptContextBuilder.ts`
  - compute dynamic prompt inputs such as creator profile, channel policy, and request-scoped instructions
- `src/prompts/types.ts`
  - prompt composition types

### Context Management

- `src/agent/PromptProjector.ts`
  - derive model-facing messages from canonical history plus local runtime memory
- `src/agent/ConversationMemoryBuilder.ts`
  - create/update summary memory after completed turns
- `src/agent/Microcompact.ts`
  - clear stale or oversized tool result content cheaply
- `src/agent/ReactiveCompact.ts`
  - overflow recovery strip-and-retry logic
- `src/agent/TokenBudget.ts`
  - hybrid token accounting and threshold checks
- `src/agent/types/memory.ts`
  - summary and prompt projection types

### Runtime Artifacts

- `src/agent/TurnTranscriptRecorder.ts`
  - persist per-turn internal records
- `src/agent/ArtifactStore.ts`
  - store large tool outputs and prompt snapshots
- `src/agent/types/artifacts.ts`
  - artifact metadata types

### Tool Runtime

- `src/tools/execution/ToolExecutor.ts`
  - single entrypoint for all tool execution
- `src/tools/execution/ToolPolicy.ts`
  - policy checks before tool execution
- `src/tools/execution/ToolHooks.ts`
  - pre/post execution hooks
- `src/tools/execution/ToolSummaryGenerator.ts`
  - generate concise tool-use summaries for later prompt projection
- `src/tools/execution/types.ts`
  - execution result, metadata, and policy types

### Runtime State and Observers

- `src/agent/ProcessRuntimeState.ts`
  - process-level mutable runtime state
- `src/agent/TurnExecutionState.ts`
  - request-scoped turn state beyond local method variables
- `src/agent/RuntimeObservers.ts`
  - health, metrics, logging, cleanup observers

### Recovery and Continuation

- `src/agent/RecoveryManager.ts`
  - centralized continuation and retry decisions
- `src/agent/types/recovery.ts`
  - continuation reasons, retry guards, and terminal reasons

### Internal Events

- `src/agent/InternalEventBus.ts`
  - optional local bus for structured runtime events
- `src/agent/types/internal-events.ts`
  - internal event union

## Existing Files To Change

The following current files should be extended, not replaced:

### `src/agent/TurnExecutor.ts`

This is the highest-leverage file.

Planned changes:

- replace direct prompt assembly with `PromptProjector`
- run `Microcompact` before expensive prompt reduction
- replace direct serial tool execution with `ToolExecutor`
- capture iteration-level metadata
- capture terminal reason consistently
- emit internal events
- record turn transcript snapshots
- route continuation and retry logic through `RecoveryManager`
- record token estimates and actual usage where available

### `src/agent/SessionState.ts`

Planned changes:

- add summary memory storage
- add prompt projection metadata
- add recent tool outcome cache
- add tool-use summary state
- add content replacement metadata where useful
- keep canonical history and prompt history split
- support memory rebuild after reseed

### `src/agent/SessionRuntime.ts`

Planned changes:

- attach richer turn transcript recording
- update conversation memory after successful turns
- persist tool-use summaries into conversation runtime state
- emit structured task/turn lifecycle events
- expose more detailed runtime snapshots

### `src/agent/SessionManager.ts`

Planned changes:

- manage richer conversation runtime state objects
- expose session-level stats that include memory/projection state
- keep current TTL and eviction policy

### `src/agent/Agent.ts`

Planned changes:

- maintain richer process runtime counters
- expose process runtime health snapshot
- register runtime observers

### `src/tools/types.ts`

Planned changes:

- extend tool definition to support:
  - input schema
  - validation separate from schema parsing where useful
  - timeout
  - result size budget
  - input-dependent concurrency logic
  - optional policy category
  - result mapping
  - tool-use summary support

### `src/tools/registry.ts`

Planned changes:

- support richer tool definitions
- expose tool metadata for health and policy

### `src/agent/types.ts`

Planned changes:

- expand public event and internal result types
- add terminal reason typing
- add request-scoped execution metadata

### `src/agent/RolloutRecorder.ts`

Planned changes:

- keep current JSONL logging
- narrow its responsibility to rollout events
- move transcript-grade storage into `TurnTranscriptRecorder`

## Implementation Phases

## Phase 0: Prompt Composition Boundaries and Cheapest Compaction

### Goal

Separate prompt-building concerns from context-shaping concerns, then add the cheapest high-ROI context controls before any LLM-based summarization.

### Work

1. Add prompt composition boundaries:
   - `SystemPromptBuilder.ts`
   - `PromptSections.ts`
   - `PromptContextBuilder.ts`
2. Add `TokenBudget.ts`
3. Add `Microcompact.ts`
4. Define persisted vs ephemeral transcript entry categories
5. Define threshold bands for:
   - microcompact
   - summary compaction
   - overflow recovery

### Expected File Changes

- `src/prompts/*`
- `src/agent/TurnExecutor.ts`
- `src/agent/types.ts`
- new `src/agent/TokenBudget.ts`
- new `src/agent/Microcompact.ts`

### Exit Criteria

- system prompt assembly is isolated from conversation history projection
- oversized or stale tool outputs can be cleared or replaced cheaply
- request execution can estimate prompt pressure before model call
- token thresholds are explicit rather than ad hoc

## Phase 1: Context Projection

### Goal

Keep the current turn loop intact but stop treating prompt history as a mostly append-only structure.

### Work

1. Add `ConversationMemoryBuilder.ts`
2. Add `PromptProjector.ts`
3. Extend `SessionState.ts` with:
   - `summaryMemory`
   - `promptProjectionVersion`
   - `recentToolOutcomes`
   - `toolUseSummaries`
4. Update `TurnExecutor.ts` so the model call uses projected messages instead of directly using only the current prompt history

### Expected File Changes

- `src/agent/TurnExecutor.ts`
- `src/agent/SessionState.ts`
- new `src/agent/ConversationMemoryBuilder.ts`
- new `src/agent/PromptProjector.ts`

### Exit Criteria

- turn execution still passes existing behavior
- prompt assembly is explicitly separated from canonical history storage
- completed turns can update summary memory

## Phase 2: Internal Turn Transcript and Artifact Storage

### Goal

Persist a richer internal record than the platform-visible chat history.

### Work

1. Add `TurnTranscriptRecorder.ts`
2. Add `ArtifactStore.ts`
3. Record for each request:
   - prompt snapshot
   - model provider and model
   - iteration count
   - tool calls
   - tool results
   - terminal reason
   - token usage
4. Persist large tool outputs through `ArtifactStore` instead of retaining them only inline
5. Use append-only JSONL for transcript-grade records
6. Define transcript read safety limits and persisted-vs-ephemeral entry policy

### Expected File Changes

- `src/agent/SessionRuntime.ts`
- `src/agent/TurnExecutor.ts`
- `src/agent/RolloutRecorder.ts`
- new `src/agent/TurnTranscriptRecorder.ts`
- new `src/agent/ArtifactStore.ts`

### Exit Criteria

- every completed request has a durable internal transcript entry
- large tool outputs can be stored and referenced
- rollout logging remains lightweight and readable
- transcript format is append-only and streaming-friendly
- OOM/read safety rules are explicit

## Phase 3: Tool Runtime and Policy Hooks

### Goal

Make tool execution a first-class subsystem before the tool set expands.

### Work

1. Add `ToolExecutor.ts`
2. Add `ToolPolicy.ts`
3. Add `ToolHooks.ts`
4. Add `ToolSummaryGenerator.ts`
4. Extend tool definitions with:
   - schema
   - validateInput
   - timeout
   - result size limits
   - policy category
   - input-dependent concurrency marker
   - result mapping
   - summary support
5. Route all tool execution in `TurnExecutor.ts` through `ToolExecutor`
6. Define whether execution remains serial initially or supports partial streaming execution per tool class

### Expected File Changes

- `src/agent/TurnExecutor.ts`
- `src/tools/types.ts`
- `src/tools/registry.ts`
- `src/tools/web-search.ts`
- new `src/tools/execution/ToolExecutor.ts`
- new `src/tools/execution/ToolPolicy.ts`
- new `src/tools/execution/ToolHooks.ts`
- new `src/tools/execution/ToolSummaryGenerator.ts`

### Exit Criteria

- no tool is executed directly from `TurnExecutor.ts`
- every tool passes through shared policy checks
- every tool produces normalized execution metadata
- oversized tool results can be summarized or externalized
- tool-use summaries can feed later prompt projection

## Phase 4: Explicit Runtime State and Observers

### Goal

Make runtime state more inspectable and side effects more deliberate.

### Work

1. Add `ProcessRuntimeState.ts`
2. Add `TurnExecutionState.ts`
3. Add `RuntimeObservers.ts`
4. Make `RuntimeObservers.ts` the main onChange-style choke point for runtime side effects
5. Move process-level counters and health shaping out of ad hoc fields where appropriate
6. Wire observers for:
   - health stats
   - metrics
   - heartbeat state
   - cleanup

### Expected File Changes

- `src/agent/Agent.ts`
- `src/agent/SessionManager.ts`
- `src/agent/SessionRuntime.ts`
- new `src/agent/ProcessRuntimeState.ts`
- new `src/agent/TurnExecutionState.ts`
- new `src/agent/RuntimeObservers.ts`

### Exit Criteria

- process runtime health can be described from one place
- turn execution state is no longer only implicit in local variables
- observers handle operational side effects consistently
- state-diff-driven side effects are centralized instead of scattered

## Phase 5: Recovery and Continuation

### Goal

Make retry and continuation behavior explicit, guarded, and inspectable.

### Work

1. Add `RecoveryManager.ts`
2. Track:
   - continuation reason
   - fallback attempted
   - compaction attempted
   - max output continuation count
   - terminal reason
3. Implement the first recovery paths:
   - normal tool-result continuation
   - reactive compact on overflow
   - fallback model retry if configured
   - max-output continuation message
4. Add guards and circuit breakers to prevent repeated loops

### Expected File Changes

- `src/agent/TurnExecutor.ts`
- `src/agent/types.ts`
- new `src/agent/RecoveryManager.ts`
- new `src/agent/types/recovery.ts`

### Exit Criteria

- continuation and retry logic is explicit and testable
- the runtime records why another iteration was started
- repeated failure loops are bounded

## Phase 6: Internal Event Taxonomy

### Goal

Improve observability without changing the external SSE contract.

### Work

1. Add internal event types:
   - `request_received`
   - `request_admitted`
   - `turn_started`
   - `iteration_started`
   - `tool_started`
   - `tool_completed`
   - `tool_failed`
   - `turn_completed`
   - `turn_failed`
2. Optionally add `InternalEventBus.ts`
3. Feed rollout recording, metrics, and health observers from structured internal events

### Expected File Changes

- `src/agent/types.ts`
- `src/agent/RolloutRecorder.ts`
- `src/agent/Agent.ts`
- `src/agent/SessionRuntime.ts`
- `src/agent/TurnExecutor.ts`
- new `src/agent/types/internal-events.ts`
- optional new `src/agent/InternalEventBus.ts`

### Exit Criteria

- internal observability is richer than the public SSE stream
- external protocol remains unchanged

## Recommended PR Sequence

### PR 1: Prompt and Context Skeleton

- add `SystemPromptBuilder.ts`
- add `PromptSections.ts`
- add `PromptContextBuilder.ts`
- add `TokenBudget.ts`
- add `Microcompact.ts`
- add `ConversationMemoryBuilder.ts`
- add `PromptProjector.ts`
- extend `SessionState.ts` with memory placeholders
- minimally integrate with `TurnExecutor.ts`

### PR 2: Transcript and Artifact Storage

- add `TurnTranscriptRecorder.ts`
- add `ArtifactStore.ts`
- integrate with `SessionRuntime.ts` and `TurnExecutor.ts`

### PR 3: Tool Runtime Unification

- add `ToolExecutor.ts`
- add `ToolSummaryGenerator.ts`
- extend tool definitions
- route all tool execution through shared runtime

### PR 4: Policy Hooks

- add `ToolPolicy.ts`
- add `ToolHooks.ts`
- require shared policy checks for every tool

### PR 5: Runtime State and Observers

- add `ProcessRuntimeState.ts`
- add `TurnExecutionState.ts`
- add `RuntimeObservers.ts`

### PR 6: Recovery and Continuation

- add `RecoveryManager.ts`
- add continuation reasons and retry guards

### PR 7: Internal Events

- expand internal event vocabulary
- wire rollout and metrics to internal events

## Risks

- over-centralizing state too early and recreating a giant product-runtime object
- introducing prompt projection without preserving current canonical history semantics
- allowing tool-runtime abstractions to become too generic before enough tools exist
- increasing transcript storage volume without retention rules
- coupling observers too tightly to request execution paths
- copying `claudy` threshold math directly instead of tuning to DigitalMe runtime behavior

## Non-Goals For This Plan

This plan does not include:

- plugin systems
- MCP integration
- IDE or bridge features
- interactive permission UI
- background agent swarms
- changing the external DigitalMe platform protocol

## Success Criteria

This plan is successful if:

- `digitalme-agent` keeps its current protocol and runtime shape
- cheap compaction happens before expensive compaction
- prompt growth is controlled through projection and summary memory
- tool execution becomes policy-aware and observable
- internal transcripts are good enough for debugging and audits
- process and conversation runtime state become easier to inspect and evolve
