# Improving DigitalMe Agent by Learning from Claudy

## Purpose

This memo documents which architectural ideas from `claudy` are worth borrowing for `digitalme-agent`, and which ones are not.

## Sector Docs

Detailed implementation-track docs live in:

### Runtime Hardening (original tracks)

- `01_prompt_management/IMPLEMENTATION_PLAN.md` **(DONE)**
- `02_context_management/IMPLEMENTATION_PLAN.md`
- `03_tool_runtime/IMPLEMENTATION_PLAN.md`
- `04_recovery_and_continuation/IMPLEMENTATION_PLAN.md`
- `05_transcript_and_artifact_storage/IMPLEMENTATION_PLAN.md`
- `06_runtime_state_and_observers/IMPLEMENTATION_PLAN.md`
- `07_internal_events_and_observability/IMPLEMENTATION_PLAN.md`
- `08_forked_and_subagents/IMPLEMENTATION_PLAN.md` **(DONE)**

### Operational Maturity (new tracks from second Claudy deep-dive)

- `09_model_routing_and_intelligence/IMPLEMENTATION_PLAN.md` — multi-model selection, fallback chains, cost-aware routing, effort levels
- `10_creator_guardrails_and_safety/IMPLEMENTATION_PLAN.md` — content safety, creator-defined boundaries, jailbreak detection, input/output screening
- `11_usage_tracking_and_quotas/IMPLEMENTATION_PLAN.md` — per-creator cost tracking, quota enforcement, usage analytics, billing data
- `12_configuration_lifecycle/IMPLEMENTATION_PLAN.md` — config hot-reload, versioning, platform overrides, feature gates
- `13_structured_analytics/IMPLEMENTATION_PLAN.md` — metrics pipeline, performance profiling, error buffer, operational dashboards
- `14_creator_skills/IMPLEMENTATION_PLAN.md` — creator-defined capabilities the model invokes automatically during fan conversation

The two systems serve different purposes:

- `claudy` is a general-purpose interactive coding agent platform
- `digitalme-agent` is a public-facing creator agent runtime that serves fan conversations through the DigitalMe platform

Because of that, the goal is not to copy `claudy` wholesale. The goal is to borrow the parts of its architecture that improve robustness, observability, context handling, and tool execution for a public-agent runtime.

## Current Architectural Difference

### Claudy

`claudy` is an interactive agent runtime with a large product-wide state model and many execution surfaces.

Core traits:

- multi-surface runtime: CLI, REPL, headless/SDK, bridge/remote control, server-backed sessions
- a rich ReAct-style turn loop with retries, compaction, streaming tool execution, and policy checks
- a broad tool system with dynamic capability discovery
- plugins, skills, MCP integration, bridge integration, background tasks, and session persistence

Key files:

- `/home/rich/dev/study/claudy/src/main.tsx`
- `/home/rich/dev/study/claudy/src/query.ts`
- `/home/rich/dev/study/claudy/src/QueryEngine.ts`
- `/home/rich/dev/study/claudy/src/state/AppStateStore.ts`
- `/home/rich/dev/study/claudy/src/services/tools/toolOrchestration.ts`
- `/home/rich/dev/study/claudy/src/services/tools/toolExecution.ts`
- `/home/rich/dev/study/claudy/src/utils/sessionStorage.ts`
- `/home/rich/dev/study/claudy/src/utils/toolResultStorage.ts`

### DigitalMe Agent

`digitalme-agent` is an HTTP-first agent service implementing a narrow protocol for the DigitalMe platform.

Core traits:

- request-driven HTTP service
- bounded in-memory session cache
- platform-facing SSE protocol
- small tool registry
- process-local queueing and per-conversation FIFO
- relatively simple turn execution loop

Key files:

- `/home/rich/dev/airepublic/sodapop/s1/digitalme-agent/src/index.ts`
- `/home/rich/dev/airepublic/sodapop/s1/digitalme-agent/src/server.ts`
- `/home/rich/dev/airepublic/sodapop/s1/digitalme-agent/src/routes/turns.ts`
- `/home/rich/dev/airepublic/sodapop/s1/digitalme-agent/src/agent/Agent.ts`
- `/home/rich/dev/airepublic/sodapop/s1/digitalme-agent/src/agent/SessionManager.ts`
- `/home/rich/dev/airepublic/sodapop/s1/digitalme-agent/src/agent/SessionRuntime.ts`
- `/home/rich/dev/airepublic/sodapop/s1/digitalme-agent/src/agent/SessionState.ts`
- `/home/rich/dev/airepublic/sodapop/s1/digitalme-agent/src/agent/TurnExecutor.ts`
- `/home/rich/dev/airepublic/sodapop/s1/digitalme-agent/src/tools/registry.ts`

## Shared Runtime Shape

Before discussing improvements, it is important to be precise about what is already true:

- `digitalme-agent` and `claudy` already share the same core runtime pattern
- both are ReAct-style agent runtimes
- both maintain session/conversation context
- both accept one user request and run a loop
- both call the LLM, execute tools when needed, append tool results, and continue until no follow-up is needed

The main difference is not the fundamental runtime architecture. The main difference is execution maturity.

`claudy` has a more developed implementation of the same core runtime shape:

- richer prompt/context management
- richer tool orchestration
- more recovery and continuation paths
- more explicit runtime state and artifact handling
- more observability and side-effect management

This memo should therefore be read as a maturity and hardening plan, not as a proposal to replace the existing `digitalme-agent` runtime model.

## Concept Mapping

The two codebases use similar concepts but not always the same names.

| DigitalMe Agent | Closest Claudy Concept | Notes |
|---|---|---|
| conversation | session | `claudy` mostly treats the live session and transcript together rather than separating conversation from session as strongly |
| `/v1/task` request | turn | one inbound request in `digitalme-agent` maps most closely to one user turn in `claudy` |
| turn loop iteration | query-loop iteration | one LLM call cycle inside the request/turn |
| task | background managed task | in `claudy`, `task` usually means internal managed work such as shell jobs or sub-agents, not the top-level user request |

## Component Mapping

The table below is the most useful implementation-oriented correspondence between the two systems. These are not exact 1:1 equivalents, but they are the closest architectural matches.

| DigitalMe Agent Component | Closest Claudy Component | Why They Correspond | Important Mismatch |
|---|---|---|---|
| `src/agent/TurnExecutor.ts` | `src/query.ts` | main per-request agent loop: call model, inspect result, execute tools, continue until done | `claudy` has much richer continuation, compaction, streaming, and retry paths |
| `src/agent/SessionRuntime.ts` | `src/QueryEngine.ts` | owns conversation-scoped execution lifecycle and persists runtime state across requests/turns | `QueryEngine` also carries more session infrastructure such as usage, permissions, file state, SDK compatibility, and session persistence hooks |
| `src/agent/SessionState.ts` | `QueryEngine` mutable message state plus `sessionStorage.ts` transcript state | keeps canonical history and prompt-facing history for one conversation/session | `claudy` splits more of this across in-memory state, transcript records, compaction artifacts, and file/attribution state |
| `src/agent/SessionManager.ts` | `QueryEngine` construction + surrounding session bootstrap | creates, reuses, and evicts per-conversation runtimes | `claudy` does not center this in one TTL cache manager because it is primarily an interactive app runtime rather than an HTTP session cache |
| `src/agent/Agent.ts` | `src/main.tsx` plus runtime bootstrap and top-level health/state plumbing | process-level coordination: admission, health, drain behavior, runtime ownership | `claudy` spreads this across bootstrap, REPL/server entrypoints, and global app state rather than one narrow service class |
| `src/prompts/PromptComposer.ts` | `src/constants/prompts.ts` + `src/utils/systemPrompt.ts` + `src/utils/queryContext.ts` | builds the system prompt and gathers prompt-side context | `claudy` separates prompt sections, precedence, and context fetch much more explicitly |
| `src/tools/registry.ts` and `src/tools/types.ts` | `src/tools.ts` + `src/Tool.ts` | tool catalog plus tool contract | `claudy` tool definitions are much richer: permissions, validation, concurrency safety, result mapping, progress, and hook integration |
| inline tool execution in `TurnExecutor.ts` | `src/services/tools/toolOrchestration.ts` + `src/services/tools/toolExecution.ts` + `src/services/tools/StreamingToolExecutor.ts` | executes model-requested tools and feeds results back into the loop | `claudy` has a real execution subsystem; `digitalme-agent` currently performs direct per-call dispatch |
| `src/agent/RolloutRecorder.ts` | `src/utils/sessionStorage.ts` + `src/utils/toolResultStorage.ts` | durable internal operational records | `claudy` stores richer transcript and artifact types, plus content-replacement records and resume-safe metadata |
| `src/agent/EventQueue.ts` and `src/agent/types.ts` | internal hook/event surfaces across query, tools, and app state | stream and record runtime lifecycle information | `claudy` uses a broader event/hook surface and projects only some of it outward |

### Practical Reading Map

If someone is working on a specific `digitalme-agent` subsystem, these are the most relevant `claudy` references to read first:

- prompt management
  - `src/prompts/PromptComposer.ts`
  - read `src/constants/prompts.ts`, `src/utils/systemPrompt.ts`, `src/utils/queryContext.ts`
- context management
  - `src/agent/SessionState.ts`, `src/agent/TurnExecutor.ts`
  - read `src/query.ts` and the compaction modules under `src/services/compact/`
- tool runtime
  - `src/tools/registry.ts`, `src/tools/types.ts`, `src/agent/TurnExecutor.ts`
  - read `src/Tool.ts`, `src/services/tools/toolOrchestration.ts`, `src/services/tools/toolExecution.ts`, `src/services/tools/StreamingToolExecutor.ts`
- conversation runtime
  - `src/agent/SessionRuntime.ts`, `src/agent/SessionManager.ts`
  - read `src/QueryEngine.ts`
- runtime state and observers
  - `src/agent/Agent.ts`, `src/agent/SessionManager.ts`
  - read `src/state/AppStateStore.ts`, `src/state/onChangeAppState.ts`
- transcript and artifacts
  - `src/agent/RolloutRecorder.ts`
  - read `src/utils/sessionStorage.ts`, `src/utils/toolResultStorage.ts`

### Mapping Boundaries

Some `claudy` pieces should be treated as reference patterns, not direct counterparts:

- `src/state/AppStateStore.ts`
  - useful as a state-layering reference
  - not something `digitalme-agent` should mirror directly
- `src/main.tsx`
  - useful as a bootstrap/composition root reference
  - not a runtime equivalent to one single `digitalme-agent` class
- MCP, plugins, bridge, slash commands, REPL UI
  - mostly out of scope for a public-facing creator agent runtime

## The Main Architectural Insight

`claudy` is useful as a reference not because it is “bigger,” but because it has already solved several hard runtime problems that `digitalme-agent` will eventually hit:

- prompt/context growth over long sessions
- richer tool ecosystems
- internal observability requirements
- durable runtime artifacts
- cross-cutting policy enforcement
- execution-state management beyond a single turn

DigitalMe Agent should keep its service-oriented shape, but borrow `claudy` patterns in the following areas.

## What DigitalMe Agent Already Has

The current design already has meaningful architecture that should be preserved and extended:

- bounded in-memory session caching in `SessionManager.ts`
- per-conversation FIFO execution in `SubmissionQueue.ts`
- a clear request-scoped run loop in `TurnExecutor.ts`
- a useful split between canonical history and prompt history in `SessionState.ts`
- rollout logging in `RolloutRecorder.ts`

The plan below assumes these foundations remain in place.

## Improvements Worth Borrowing

## 1. Layered Runtime State

### Current DigitalMe Agent State

Today the state is split across:

- process-wide queue/drain stats in `Agent.ts`
- session map, TTL eviction, and capacity policy in `SessionManager.ts`
- per-conversation lifecycle in `SessionRuntime.ts`
- canonical and prompt-expanded history in `SessionState.ts`

This is already a good start, but the state model is still implicit and distributed.

### Claudy Pattern

`claudy` centralizes long-lived runtime state in `AppStateStore.ts` and handles side effects separately in `onChangeAppState.ts`.

The exact shape is too large for DigitalMe Agent, and should not be copied directly. What is valuable is the pattern:

- one explicit runtime state object
- one explicit conversation state object
- one explicit turn execution state
- one side-effect layer that reacts to state changes
- one choke point where state diffs trigger side effects instead of scattering those effects across the codebase

### Recommendation

Introduce a cleaner layered runtime model without creating a giant product-wide state container:

- `ProcessRuntimeState`
  - queue pressure
  - active conversations
  - draining status
  - model/provider health
  - tool inventory
  - heartbeat state
  - rollout/logging mode
- `ConversationRuntimeState`
  - canonical platform history
  - prompt history
  - summary memory
  - token usage
  - recent tool outcomes
- `TurnExecutionState`
  - current turn metadata
  - current iteration metadata
  - tool execution metadata
  - terminal reason of last turn
- `RuntimeObservers`
  - metrics emission
  - rollout persistence
  - health/heartbeat updates
  - cleanup logic

The preferred pattern is:

- state mutation happens in one place
- side effects react to state diffs through one `onChange`-style choke point
- request code should not directly trigger many unrelated side effects

### Why This Helps

This keeps the runtime understandable as the agent grows. It also prevents state logic, logging logic, and operational logic from spreading across too many classes.

## 2. Durable Internal Transcript and Artifact Storage

### Current DigitalMe Agent Situation

The platform is the system of record for visible chat history:

- `/home/rich/dev/airepublic/sodapop/s1/digitalme-platform/platform/app/services/chat.py`
- `/home/rich/dev/airepublic/sodapop/s1/digitalme-platform/platform/README.md`

But the platform only persists final delivered assistant text as chat history.

The agent currently has `RolloutRecorder.ts`, which records useful JSONL traces, but not a full internal transcript model.

### Claudy Pattern

`claudy` persists:

- transcripts
- session metadata
- tool outputs
- content replacements
- compacted or derived prompt artifacts

Relevant files:

- `/home/rich/dev/study/claudy/src/utils/sessionStorage.ts`
- `/home/rich/dev/study/claudy/src/utils/toolResultStorage.ts`

### Recommendation

Add agent-side durable runtime artifacts that are separate from platform chat storage:

- append-only JSONL transcript format
- normalized per-turn internal transcript
- prompt snapshot used for the model call
- tool call/result records
- retries and terminal reason
- token usage
- compacted summaries or memory records
- references to large tool outputs stored on disk
- explicit distinction between persisted and ephemeral entries
- transcript read budget / OOM safety limits
- optional sidecar metadata for session-level or conversation-level state

Examples of persisted entries:

- request started/completed
- prompt projection snapshot
- tool execution records
- content replacement records
- summary memory updates
- terminal reason

Examples of ephemeral entries:

- per-chunk progress
- temporary streaming status
- UI-only or transient execution noise

### Why This Helps

This gives the agent a richer operational memory than the platform transcript alone.

That becomes important when:

- tools become more capable
- prompts become summarized rather than fully replayed
- debugging production behavior becomes harder
- safety or moderation audits need deeper turn traces

## 3. Context Compaction and Prompt Projection

### Current DigitalMe Agent Situation

`SessionState.ts` already distinguishes:

- `canonicalHistory`
- `promptHistory`

That is the right foundation, but today prompt history still mostly grows linearly.

### Claudy Pattern

`claudy` has multiple mechanisms in `query.ts` that reduce or reshape prompt history before the next model call:

- microcompact
- context collapse / projection
- autocompact
- reactive compact
- result-size control
- protected recent context

The important pattern is not “summarize when long.” The important pattern is a graduated compaction strategy:

1. cheapest reduction first
2. more expensive summarization only when needed
3. emergency recovery only on actual overflow/failure

In `claudy`, these layers are progressively more aggressive:

- Microcompact
  - clears stale or oversized tool result content cheaply
  - runs frequently
  - no extra LLM call required
- Context collapse / projection
  - creates summarized externalized state while preserving a useful recent view
  - more granular than full compaction
- Autocompact
  - performs a fuller summarization pass before hitting hard limits
- Reactive compact
  - emergency strip-and-retry path after prompt-too-long or similar failures

Other important patterns:

- circuit breakers to stop infinite retry loops
- threshold bands rather than a single compaction threshold
- post-compact prompt structure that preserves continuity instead of replacing everything with one blob
- memory prefetch overlapped with model streaming when possible

DigitalMe Agent does not need the full `claudy` machinery, but it should borrow the principle.

### Recommendation

Adopt a graduated compaction strategy:

#### Phase-appropriate compaction stack

- Microcompact
  - first compaction feature to implement
  - clear stale tool outputs or replace them with references/previews
- Prompt projection + summary memory
  - derive model-facing context from canonical history plus summary memory
- Reactive compact on overflow
  - if the prompt still overflows, recover by stripping/summarizing and retrying
- Optional later: granular context collapse
  - if long conversations with many tools demand finer-grained preservation

The projected prompt should:

- preserve canonical history as the source of truth
- derive model-facing prompt history from canonical history
- summarize older conversation spans into durable conversation memory
- keep a recent tail verbatim
- keep raw tool traces out of the prompt unless needed
- preserve a stable post-compact structure so session continuity remains understandable

The implementation should also define:

- token-trigger thresholds
- maximum retries
- circuit breakers on repeated compaction failure
- how to preserve recent tool and summary context after compaction

Possible module shape:

- `ConversationMemoryBuilder`
- `PromptProjector`
- `SummaryStore`
- `Microcompact`
- `ReactiveCompact`

### Why This Helps

Fan conversations can be long-running and repetitive. Without compaction, prompt cost and context drift will become real problems.

This is probably the highest-leverage architectural improvement to borrow from `claudy`.

## 4. Error Recovery and Continuation

`claudy` does not only loop on tool results. It has multiple continuation and recovery paths with guards to prevent death spirals.

Relevant patterns:

- normal tool-result continuation
- model fallback on upstream failure
- prompt-too-long recovery through compaction
- max-output continuation by nudging the next iteration to resume mid-thought
- hook- or policy-driven continuation
- circuit breakers and one-shot guards on retries

### Recommendation

DigitalMe Agent should add an explicit recovery and continuation section to its runtime design.

The most relevant recovery paths are:

- normal tool-result continuation
- model fallback
- reactive compact on overflow
- max-output continuation message
- retry guards and circuit breakers

Suggested state fields:

- `continuationReason`
- `hasAttemptedReactiveCompact`
- `maxOutputRecoveryCount`
- `fallbackAttempted`
- `terminalReason`

### Why This Helps

As soon as the runtime gets longer conversations, more tools, or multiple providers, simple success/fail branching becomes too weak.

## 5. Token Accounting and Budget Triggers

Another important runtime pattern in `claudy` is hybrid token accounting:

- use real API token usage when available
- estimate where exact counts are not yet available
- trigger compaction or continuation based on threshold bands, not guesswork alone

### Recommendation

DigitalMe Agent should define:

- how request token usage is recorded
- how prompt-size estimates are computed before the model call
- when microcompact triggers
- when summary compaction triggers
- when overflow recovery triggers

This does not need to copy `claudy`'s exact threshold math, but it should adopt the same principle:

- cheap intervention first
- expensive intervention later
- emergency recovery last

### Why This Helps

Without token accounting, prompt projection and compaction become ad hoc and difficult to tune.

## 6. Richer Tool Runtime

### Current DigitalMe Agent Situation

The tool system is intentionally minimal:

- tool interface in `src/tools/types.ts`
- simple registry in `src/tools/registry.ts`
- current concrete tool in `src/tools/web-search.ts`

This is correct for MVP, but it will become restrictive as tools grow.

### Claudy Pattern

`claudy` separates:

- tool definition
- tool execution context
- orchestration
- concurrency control
- hooks
- validation
- result handling

Two distinct layers matter:

- tool definition metadata
- tool execution infrastructure

The current doc mostly covers metadata; the execution infrastructure is just as important.

Relevant files:

- `/home/rich/dev/study/claudy/src/Tool.ts`
- `/home/rich/dev/study/claudy/src/services/tools/toolOrchestration.ts`
- `/home/rich/dev/study/claudy/src/services/tools/toolExecution.ts`

### Recommendation

Evolve the DigitalMe tool runtime to support:

- per-tool input schema
- validateInput separate from schema parsing where needed
- per-tool timeout policy
- per-tool result-size policy
- per-tool concurrency classification
- input-dependent concurrency safety, not only static flags
- optional destructive/read-only classification
- result mapping / normalization
- pre-tool and post-tool hooks
- richer tool execution context
- normalized tool execution records
- tool-use summary generation
- result persistence and preview generation for oversized outputs
- streaming or incremental execution support where it materially reduces latency

Suggested interface additions:

- `schema`
- `timeoutMs`
- `maxResultChars`
- `isConcurrencySafe(input)`
- `validateInput()`
- `checkPolicy()`
- `beforeExecute()`
- `afterExecute()`
- `onError()`
- `mapResult()`
- `getToolUseSummary()`

### Why This Helps

This makes the tool runtime scale without turning each tool into its own mini-framework.

It also gives one place to inject:

- moderation controls
- creator-level tool restrictions
- platform policy checks
- observability

This should be treated as tightly coupled with policy enforcement. New tools should not be added without a shared control point for deciding whether they are allowed to run in the current request.

## 7. Tool Use Summaries

One particularly good pattern in `claudy` is generating concise summaries of tool work so the agent does not need to keep re-reading raw tool results in later iterations.

### Recommendation

DigitalMe Agent should support tool-use summaries as a first-class prompt artifact.

A summary record can capture:

- which tools ran
- what they found or changed
- what still matters for the next iteration

These summaries can then be fed into:

- prompt projection
- transcript artifacts
- continuity restoration

### Why This Helps

This reduces prompt bloat and helps maintain long-running coherence even when tool outputs are large.

## 8. Internal Event Model Richer Than External SSE

### Current DigitalMe Agent Situation

The external protocol intentionally exposes a small event set:

- `text_delta`
- `tool_start`
- `tool_end`
- `done`
- `error`

This is correct for the platform relay.

### Claudy Pattern

`claudy` has many more internal state transitions and event types than its external surfaces expose.

### Recommendation

Keep the public SSE contract small, but make the internal event model richer.

Add internal events such as:

- `request_received`
- `request_admitted`
- `model_turn_started`
- `model_turn_completed`
- `tool_validation_failed`
- `tool_started`
- `tool_completed`
- `tool_failed`
- `retry_started`
- `summary_updated`
- `turn_completed`
- `turn_failed`

These events can feed:

- rollout recording
- metrics
- health reporting
- debugging tools

Future extension point:

- creator-defined or operator-defined hooks reacting to internal lifecycle events

### Why This Helps

The platform only needs a simple stream. The runtime needs much better operational visibility.

## 9. Centralized Policy Hooks Instead of Interactive Permissions

### Claudy Pattern

`claudy` has a strong centralized permission system because it is an interactive coding agent.

### What To Borrow

Do not borrow the user approval UI or REPL permission flow.

Borrow the architectural idea that dangerous operations should pass through a shared decision point.

### Recommendation

Introduce a policy layer between the turn executor and tool execution:

- creator-level policy
- platform-level policy
- request-level policy
- moderation policy
- tool-category policy

Possible module:

- `PolicyEngine`

Responsibilities:

- approve or reject tool use
- apply request-scoped restrictions
- add safe defaults for public-facing usage
- record policy decisions in rollout artifacts

### Why This Helps

A public-facing agent has very different safety needs than a coding assistant, but it still benefits from having a central control point before tool execution.

This work should begin together with richer tool runtime work, not far afterward.

## 10. Smarter Session Continuity

### Current DigitalMe Agent Situation

Session continuity is bounded and in-memory:

- session cache in `SessionManager.ts`
- canonical/prompt history in `SessionState.ts`
- TTL eviction in `SessionManager.ts`

This is appropriate, but continuity is still relatively shallow.

### Claudy Pattern

`claudy` treats sessions as durable runtime objects with transcript and artifact persistence.

### Recommendation

Keep the bounded session cache, but strengthen the continuity model by storing:

- conversation summary memory
- recent tool outcomes
- recent safety/policy decisions
- last prompt projection metadata
- transcript-backed content replacement decisions
- resume-safe terminal and retry state where useful

If the process restarts or a session is reseeded from platform history, this internal metadata can be rebuilt or restored more accurately.

### Why This Helps

This gives better continuity than simply replaying the raw visible history every time.

## What Not To Borrow

`claudy` contains many subsystems that are not a good fit for DigitalMe Agent.

Do not borrow:

- REPL/UI architecture
- slash command framework
- IDE bridge / remote control system
- plugin marketplace
- MCP client/server integration
- background task swarms
- interactive permission prompts
- very broad app-wide mutable product state
- file history and delta tracking (agent doesn't edit files)
- session resume UI (cold-start from platform is sufficient)

These solve “agent operating environment” problems, not “creator-hosted public conversation runtime” problems.

## Recommended Roadmap

## Phase 0: Cheapest High-ROI Foundation

1. Add microcompact for stale/oversized tool result clearing
2. Define token accounting strategy and thresholds
3. Define persisted vs ephemeral transcript entry types

## Phase 1: Highest Leverage

1. Add prompt projection and conversation summary memory
2. Expand rollout recording into internal turn transcript storage
3. Add richer tool execution metadata together with shared policy hooks for every non-trivial tool
4. Add tool-use summaries

## Phase 2: Runtime Hardening

1. Formalize process runtime state and conversation runtime state
2. Add richer internal event taxonomy
3. Add large tool result storage and references
4. Add explicit terminal reasons and retry records
5. Add error recovery and continuation paths

## Phase 3: Operational Maturity (new tracks 09-13)

1. **Model routing and intelligence** (track 09) — cost-aware routing, fallback chains, effort levels
2. **Creator guardrails and safety** (track 10) — input screening, output validation, jailbreak detection
3. **Usage tracking and quotas** (track 11) — cost accounting, quota enforcement, billing data
4. **Configuration lifecycle** (track 12) — hot-reload, versioning, platform overrides, feature gates
5. **Structured analytics** (track 13) — metrics pipeline, profiling, error buffer, dashboards

### Phase 3 Priority Within New Tracks

If resources are limited, prioritize in this order:

1. **Track 10 (Guardrails)** — safety is non-negotiable for a public-facing agent
2. **Track 09 (Model Routing)** — direct cost savings from background model routing
3. **Track 11 (Usage Tracking)** — required for sustainable operations and billing
4. **Track 13 (Analytics)** — needed for debugging and operational awareness
5. **Track 14 (Creator Skills)** — highest product impact, turns chatbots into capable agents
6. **Track 12 (Config Lifecycle)** — quality-of-life, can be deferred longest

## Best Three Ideas To Borrow First

If only three `claudy` ideas are adopted, the best ones are:

1. graduated compaction starting with microcompact
2. richer tool runtime with policy hooks and tool-use summaries
3. durable internal transcripts and artifacts

### Next Three Ideas (from the second deep-dive)

After the original three, the next most valuable are:

4. creator guardrails with input screening and output validation (track 10)
5. cost-aware model routing with background model assignment (track 09)
6. structured analytics replacing console.log (track 13)
7. creator skills turning chatbots into capable agents (track 14)

These provide the most benefit to DigitalMe Agent without importing `claudy`'s product complexity.

## Proposed Target Direction

DigitalMe Agent should evolve toward this shape:

- keep the current HTTP protocol and platform-facing simplicity
- keep bounded in-memory session caching
- add a stronger internal runtime architecture
- make prompt state a derived artifact, not just an append-only history
- treat tool execution as a first-class runtime subsystem
- preserve a richer internal transcript than the platform-visible chat history
- enforce creator-defined safety boundaries at runtime, not just in prompts
- route different execution contexts to cost-appropriate models
- track and enforce usage quotas for sustainable operations
- provide production-grade observability through structured metrics

In short:

- keep `digitalme-agent` as a focused public-agent runtime
- borrow `claudy`'s runtime discipline, not `claudy`'s whole product surface
- add the operational maturity layer that a public-facing service demands
- enable creators to define skills that turn personality chatbots into capable agents
