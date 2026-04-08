# DigitalMe Agent Implementation Plan

## Purpose

This plan converts the agent design into an execution order that minimizes integration churn with the platform work.

The agent should not be implemented as an isolated prototype first. The safest path is to build the reusable model/runtime layer, then the HTTP protocol, then integrate only after the platform owns local conversation persistence.

The platform remains the canonical source of truth for conversations and messages. Agent-side active conversation state is an optimization layer that must be rebuildable from platform data.

## Milestones

### Milestone 0: Freeze Upstream Source

- Pin the exact BrowserX commit SHA from `https://github.com/The-AI-Republic/browserx`.
- Record that SHA in the agent repo docs and implementation notes.
- Treat that pinned SHA as the extraction baseline for all BrowserX-derived files.

Exit criteria:
- one exact upstream commit is documented
- no implementation task depends on moving `main`

### Milestone 1: Repo Bootstrap

- Create the new `digitalme-agent` repository.
- Initialize TypeScript project structure.
- Add build tooling such as `tsup` or `esbuild`.
- Add config loading and schema validation.
- Add Dockerfile and local run scaffolding.

Exit criteria:
- repository builds successfully
- config loads and validates without agent/runtime code yet

### Milestone 2: Extract Model Layer

- Extract `ModelClient.ts`.
- Extract `ModelClientFactory.ts`.
- Extract `ModelClientError.ts`.
- Extract `ResponseStream.ts`.
- Extract `SSEEventParser.ts`.
- Extract `RequestQueue.ts`.
- Extract provider clients from `src/core/models/client/*.ts`.
- Remove BrowserX-specific config/auth/storage/backend-routing dependencies.
- Replace BrowserX tool/config imports with local equivalents.

Exit criteria:
- extracted model layer compiles
- provider clients can be instantiated with local config types

### Milestone 3: Build Runtime Core

- Implement `Agent`.
- Implement `SubmissionQueue`.
- Implement `EventQueue`.
- Implement `TurnContext`.
- Implement `TurnExecutor`.
- Implement `ActiveConversationManager`.
- Keep FIFO within `conversation_id`.
- Keep concurrency across different conversations.
- Enforce best-effort in-process duplicate `request_id` protection.

Exit criteria:
- request submission and queueing behavior work locally
- one active conversation does not block unrelated conversations
- active conversation state can be created, updated, evicted, and reseeded from platform history

### Milestone 4: Implement HTTP Protocol

- Implement `/health`.
- Implement `/verify`.
- Implement `/v1/turn`.
- Implement HMAC validation middleware.
- Implement request schema validation.
- Implement SSE streaming response format.
- Guarantee terminal `done` or `error`.

Exit criteria:
- agent accepts authenticated platform requests
- `/verify` and `/v1/turn` match the agreed contract

### Milestone 5: Add Tooling And Prompt Composition

- Implement local tool registry.
- Implement approved read-only tools only.
- Implement prompt composer around creator prompt, tool policy, supplied history, and latest message.
- Ensure canonical history is consumed exactly as provided by the platform on cold start or resync.
- Allow prompt composition to combine supplied canonical history with active cached state when present.

Exit criteria:
- one end-to-end turn can use creator prompt plus supplied canonical history
- tool calls emit `tool_start` and `tool_end` correctly

### Milestone 6: Add Liveness And Shutdown

- Implement graceful shutdown/drain behavior.
- Implement queue/health metrics.
- Implement proactive heartbeat requests from agent to platform.
- Make heartbeat cadence and stale thresholds configurable.

Exit criteria:
- agent can report liveness proactively
- in-flight shutdown behavior is defined and testable

### Milestone 7: Integration With Platform

- Connect one agent deployment to one platform environment.
- Validate HMAC interoperability.
- Validate `/verify`.
- Validate `POST /v1/turn`.
- Validate SSE `text_delta`, `done`, and `error` behavior under platform relay.
- Validate same-conversation FIFO behavior with repeated sends.
- Validate cold-start reseed after agent restart.

Exit criteria:
- one creator deployment works end to end with the updated platform

### Milestone 8: Tests And Documentation

- Add unit tests for HMAC validation.
- Add queueing tests for FIFO behavior.
- Add tests for duplicate in-flight `request_id`.
- Add smoke tests for kept model providers.
- Add one contract test for tool-call streaming.
- Document local run, Docker deployment, and platform integration.

Exit criteria:
- agent repo has enough tests and docs to support implementation handoff

## Recommended PR Sequence

### PR 1: Repo Bootstrap And BrowserX Pin

- create repo skeleton
- add config schema
- record BrowserX commit SHA

### PR 2: Model Layer Extraction

- extract/prune BrowserX model code
- compile and smoke test providers

### PR 3: Agent Core Runtime

- add `Agent`, queues, turn executor, and types
- add active conversation management and cache eviction

### PR 4: HTTP Protocol

- add `/health`, `/verify`, `/v1/turn`, HMAC, and SSE

### PR 5: Tools, Prompting, Heartbeats

- add prompt composition
- add tool registry
- add proactive heartbeat support

### PR 6: Platform Integration And Verification

- run against updated platform
- fix protocol mismatches
- document deployment

## Dependencies On Platform Work

The agent can start before the platform rewrite is complete, but full integration should wait for:

- platform-owned conversation persistence
- platform-side `POST /v1/turn` relay logic
- platform idempotency and same-conversation queueing
- platform online/offline handling
- a stable cold-start history contract that can reseed agent cache after restart or cache miss

## Highest-Risk Areas

- BrowserX extraction drift if commit pinning is skipped
- hidden BrowserX dependencies in provider/model code
- terminal SSE correctness under failures
- queue behavior under concurrent requests
- active-conversation cache divergence if reseed/version handling is underspecified
- integration mismatch with platform HMAC/body signing
