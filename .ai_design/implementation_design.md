# Enable External-Facing Agent — Implementation Design

**Status:** Updated to reflect active conversation management boundary  
**Date:** 2026-03-19  
**Decision:** New repo in TypeScript, transplant BrowserX model/runtime patterns, keep the agent as a platform-facing turn executor

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Platform Boundary](#3-platform-boundary)
4. [Architecture](#4-architecture)
5. [Core Agent Design](#5-core-agent-design)
6. [Isolation Model](#6-isolation-model)
7. [Resource Access Control](#7-resource-access-control)
8. [Prompt Composition](#8-prompt-composition)
9. [API Specification](#9-api-specification)
10. [Security](#10-security)
11. [Storage](#11-storage)
12. [Scaling Strategy](#12-scaling-strategy)
13. [Configuration](#13-configuration)
14. [Deployment](#14-deployment)
15. [Implementation Checklist](#15-implementation-checklist)

---

## 1. Overview

**digitalme-agent** is a platform-facing execution runtime that creators deploy behind the DigitalMe platform. Fans never interact with the agent directly. The platform owns identity, UI, moderation, persistence, retries, billing, and analytics. The agent only executes turns and streams results back.

### Why a new repo

digitalme-agent is a **new repository** that transplants key BrowserX patterns while dropping everything that belongs to BrowserX’s browser/desktop product surface.

| What | From BrowserX | Adapted for digitalme-agent |
|------|--------------|-----------------------------|
| Model clients | OpenAI, Anthropic, Google, etc. | Reused after dependency pruning |
| Turn loop | `TurnManager` ReAct execution | Simplified turn executor |
| Queueing pattern | Serial user submissions | FIFO per `conversation_id`, concurrent across conversations |
| Platform support | Extension, desktop, server | Server only |
| Trust model | Single user operates agent | Platform is trusted caller; end users are abstracted behind platform |
| Tool system | Registry with approvals/risk | Static allowlist |

### Why TypeScript

| Consideration | TypeScript | Python | Rust |
|---------------|------------|--------|------|
| BrowserX reuse | Strong | Rewrite | Rewrite |
| LLM SDK maturity | Good | Best | Limited |
| I/O concurrency | Good | Good | Good |
| Development speed | Fast | Fast | Slower |
| MCP ecosystem | Strong | Good | Limited |

TypeScript wins because the execution bottleneck is network I/O to model providers, and the BrowserX runtime/model stack is already in TypeScript.

### Core insight

The platform is the system of record. The agent is **not the canonical owner of conversation data**.

For one platform-submitted turn:

1. Platform loads canonical conversation history from its own DB
2. Platform sends `conversation_id + history + latest message` on cold start or resync
3. Agent may combine that canonical context with its own active in-memory conversation state
4. Agent runs the ReAct loop locally
5. Agent streams text/tool events back to platform
6. Platform persists the final response and usage
7. Agent updates or evicts its local active conversation state as a derived cache

The agent still accumulates request-local state inside `TurnContext`, but it may also retain per-conversation derived memory between requests. That memory is optional, rebuildable, and never authoritative.

---

## 2. Goals & Non-Goals

### Goals

- Build `digitalme-agent` as a new repo using BrowserX model/runtime patterns
- Run as a headless Docker/Node.js service only
- Implement the DigitalMe platform-to-agent execution protocol
- Keep the agent **conversation-scoped and platform-facing**
- Support FIFO within a conversation and concurrency across conversations
- Enable creator self-hosting with minimal configuration
- Design for horizontal scaling with explicit cache-miss reseeding behavior

### Non-Goals

- UI, identity, profiles, discovery, or social features
- User auth, moderation, billing, retries, or analytics
- Platform conversation CRUD or long-term conversation storage
- MCP in MVP
- Untrusted creator code
- Browser/desktop product surfaces

---

## 3. Platform Boundary

### Ownership split

**Platform owns:**
- user identity and login
- conversation creation and persistence
- moderation and abuse controls
- retries and durable idempotency
- billing, usage analytics, and metering
- user-facing APIs and UI

**Agent owns:**
- creator-configured system prompt and model selection
- tool execution
- ReAct loop orchestration
- in-memory scheduling by `conversation_id`
- active conversation state as a derived memory/cache layer
- SSE streaming back to platform

### Mental model

The platform is the **coordinator**.  
The agent is the **executor**.

This means the agent should not know:
- who the fan is
- whether the caller is premium/free
- how conversation history is stored long-term
- how retries or idempotency are enforced durably

It only knows:
- `request_id`
- `conversation_id`
- supplied history
- latest user message
- creator deployment config
- optional previously cached active state for that `conversation_id`

---

## 4. Architecture

### Repository structure

```text
digitalme-agent/
├── src/
│   ├── index.ts
│   ├── server.ts
│   ├── routes/
│   │   ├── health.ts            # GET /health
│   │   ├── verify.ts            # POST /verify
│   │   └── turns.ts             # POST /v1/turn
│   ├── middleware/
│   │   ├── hmac.ts              # HMAC auth
│   │   └── request-limits.ts    # payload / concurrency guards
│   ├── agent/
│   │   ├── Agent.ts
│   │   ├── SubmissionQueue.ts
│   │   ├── EventQueue.ts
│   │   ├── TurnExecutor.ts
│   │   ├── TurnContext.ts
│   │   ├── shutdown.ts
│   │   └── types.ts
│   ├── protocol/
│   │   ├── schemas.ts
│   │   └── types.ts
│   ├── models/
│   │   ├── ModelClient.ts
│   │   ├── ModelClientFactory.ts
│   │   ├── ModelClientError.ts
│   │   ├── ResponseStream.ts
│   │   ├── SSEEventParser.ts
│   │   ├── RequestQueue.ts
│   │   └── client/
│   ├── tools/
│   │   ├── registry.ts
│   │   ├── web-search.ts
│   │   └── types.ts
│   ├── streaming/
│   │   ├── sse.ts
│   │   └── chat-stream.ts
│   ├── health/
│   │   └── health-monitor.ts
│   ├── prompts/
│   │   ├── PromptComposer.ts
│   │   └── fragments/
│   └── config/
│       ├── schema.ts
│       └── loader.ts
├── config.example.yaml
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

### BrowserX transplant tiers

Important caveat: the BrowserX model layer is reusable, but not isolated. `ModelClientFactory` imports BrowserX config/auth/storage abstractions, and some clients import BrowserX prompt helpers and config types. Treat these as **extractions with dependency pruning**, not blind file copies.

BrowserX source of truth:
- repo: `https://github.com/The-AI-Republic/browserx`
- before implementation begins, pin an exact commit SHA from `main`
- the pinned SHA, not the moving branch head, is the implementation baseline

#### Tier 1: Extract with dependency pruning

| BrowserX source | Target | Notes |
|-----------------|--------|-------|
| `src/core/models/ModelClient.ts` | `src/models/ModelClient.ts` | Replace BrowserX tool/config imports |
| `src/core/models/ModelClientFactory.ts` | `src/models/ModelClientFactory.ts` | Remove BrowserX config storage/auth manager wiring |
| `src/core/models/ModelClientError.ts` | `src/models/ModelClientError.ts` | Mostly direct |
| `src/core/models/ResponseStream.ts` | `src/models/ResponseStream.ts` | Direct |
| `src/core/models/SSEEventParser.ts` | `src/models/SSEEventParser.ts` | Direct |
| `src/core/models/RequestQueue.ts` | `src/models/RequestQueue.ts` | Direct |
| `src/core/models/client/*.ts` | `src/models/client/*.ts` | Remove BrowserX-specific prompt/config/backend-routing branches |
| `src/server/streaming/chat-stream.ts` | `src/streaming/chat-stream.ts` | Direct |
| `src/server/agent/shutdown.ts` | `src/agent/shutdown.ts` | Minor adaptation |
| `src/server/handlers/health.ts` | `src/routes/health.ts` | Simplify |

#### Tier 2: Adapt significantly

| BrowserX source | Target | Notes |
|-----------------|--------|-------|
| `src/core/TurnManager.ts` | `src/agent/TurnExecutor.ts` | Keep ReAct loop, strip browser/approval code |
| `src/core/QueueProcessor.ts` | `src/agent/SubmissionQueue.ts` | Conversation-keyed FIFO |
| `src/core/TurnContext.ts` | `src/agent/TurnContext.ts` | Keep request-local model/tool state |
| `src/core/prompts/PromptComposer.ts` | `src/prompts/PromptComposer.ts` | Creator-centric fragments |
| `src/server/health/health-monitor.ts` | `src/health/health-monitor.ts` | Add queue metrics |

#### Model layer dependency-pruning checklist

1. `ModelClient.ts`
- Replace BrowserX `BaseTool` imports with local tool definitions
- Replace BrowserX config types with digitalme-agent equivalents

2. `ModelClientFactory.ts`
- Remove BrowserX `AgentConfig` dependency
- Remove config storage provider usage
- Remove auth-manager/backend-routing integration

3. `client/*.ts`
- Replace BrowserX config imports with local provider config
- Replace BrowserX prompt helpers with local helpers or inline formatting
- Remove approval/browser-specific branches

4. Verification
- Compile extracted model layer before integrating `Agent`
- Add smoke tests for kept providers
- Add one contract test for tool-call streaming

---

## 5. Core Agent Design

### Class hierarchy

```text
Agent (long-lived, one per creator deployment)
├── SubmissionQueue (FIFO within conversation_id)
├── RequestContext (lifecycle + cancellation)
├── TurnExecutor (ReAct loop)
├── TurnContext (request-local state)
└── EventQueue (async iterable for SSE)
```

### Types

```typescript
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TurnSubmission {
  requestId: string;
  conversationId: string;
  userMessage: string;
  history: HistoryMessage[];   // ordered oldest -> newest, excludes userMessage
}

export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; name: string; callId: string }
  | { type: 'tool_end'; name: string; callId: string; success: boolean }
  | { type: 'turn_started'; turnNumber: number }
  | { type: 'stream_error'; error: string; retrying: boolean; attempt: number }
  | { type: 'done'; tokenUsage?: TokenUsage }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };
```

### Why SQ/EQ

| Capability | Plain handler | SQ/EQ |
|------------|--------------|-------|
| FIFO within one conversation | Manual | Built-in |
| Concurrency across conversations | Implicit | Explicit |
| Cancellation | Ad-hoc | Built-in |
| Queue observability | Manual | Built-in |
| Graceful drain | Manual | Built-in |

### Agent sketch

```typescript
export class Agent {
  private readonly activeRequests = new Map<string, RequestContext>();
  private readonly activeConversations = new Set<string>();
  private readonly pendingByConversation = new Map<string, TurnSubmission[]>();

  submit(submission: TurnSubmission): AsyncIterable<AgentEvent> {
    // enqueue by conversation_id, dispatch if idle
  }

  cancel(requestId: string): void {
    // cancel active or remove pending
  }
}
```

### Turn flow

1. Platform calls `POST /v1/turn`
2. Route validates HMAC and request schema
3. Agent enqueues by `conversation_id`
4. `TurnExecutor` builds local message list from:
   - creator prompt
   - supplied history
   - latest user message
5. ReAct loop runs until completion or `maxTurns`
6. SSE events stream back to platform
7. Request-local state is discarded

### Key decisions

1. FIFO within one `conversation_id`
2. Concurrency across different conversations
3. Agent remains fan-agnostic
4. Platform supplies canonical history; agent may cache derived active state but does not become the source of truth
5. `done` is emitted only after the whole turn is complete
6. Duplicate `request_id` handling is best-effort in-process only; durable idempotency stays on the platform

---

## 6. Isolation Model

The agent is isolated by **conversation-scoped execution**, not by owning user data.

Shared state:
- creator config
- model client instances
- tool definitions
- queue metadata

Per-request state:
- `RequestContext`
- `TurnContext`
- `EventQueue`
- local model/tool intermediate messages

Invariant:
- no mutable request state crosses conversation boundaries

---

## 7. Resource Access Control

**Platform domain**
- identity
- moderation
- persistence
- retries and idempotency
- billing and analytics

**Agent domain**
- system prompt
- model execution
- approved tools
- request scheduling

**Tool domain**
- public internet for approved read-only tools
- future creator-approved read-only integrations
- no shell, filesystem, browser profile, or irreversible side effects

```typescript
export interface ToolContext {
  conversationId: string;
}
```

---

## 8. Prompt Composition

Prompt composition is creator-centric.

MVP prompt inputs:
- creator system prompt
- creator tool policy
- supplied canonical conversation history (full stored conversation history in MVP cold-start path)
- latest user message

Optional future platform-supplied fragments:
- locale/channel hints
- moderation hints
- safe personalization fragments

Not in scope:
- agent-owned long-term memory
- direct fan identity handling

---

## 9. API Specification

### Authentication

All requests except `/health` include:

| Header | Value |
|--------|-------|
| `X-DigitalMe-Key` | API key |
| `X-DigitalMe-Signature` | HMAC-SHA256 hex digest |
| `X-DigitalMe-Timestamp` | Unix timestamp (seconds) |

Signature: `HMAC-SHA256(signing_secret, "{timestamp}:{body}")`

### Endpoints

#### `GET /health`

```json
{ "status": "ok" }
```

#### `POST /verify`

Request:
```json
{ "type": "verification", "challenge": "{32-char}" }
```

Response:
```json
{ "challenge": "{echo-same-value}" }
```

#### `POST /v1/turn`

MVP contract:
- sole caller is the DigitalMe platform
- `request_id` is unique per logical platform turn
- `conversation_id` is the scheduler key used for FIFO ordering
- `history` must be ordered oldest → newest
- `history` must exclude the current `message`
- allowed `history.role` values in MVP: `user`, `assistant`
- empty `history` is valid
- platform sends the full stored conversation history in MVP
- compacted/summarized history or incremental reseed may be added later once conversation length becomes operationally expensive
- request is invalid if payload exceeds configured `max_message_length` or `max_history_messages`

Request:
```json
{
  "request_id": "req_123",
  "conversation_id": "conv_abc",
  "message": "Hello!",
  "history": [
    { "role": "user", "content": "Earlier question" },
    { "role": "assistant", "content": "Earlier answer" }
  ]
}
```

Schema notes:
- `request_id`: string, required
- `conversation_id`: string, required
- `message`: string, required
- `history`: array of `{ role, content }`, required
- additional top-level fields are rejected in MVP

Response: `Content-Type: text/event-stream`
```text
data: {"type":"text_delta","content":"Hi"}

data: {"type":"tool_start","name":"web_search","callId":"call_1"}

data: {"type":"tool_end","name":"web_search","callId":"call_1","success":true}

data: {"type":"done","tokenUsage":{"inputTokens":100,"outputTokens":50,"totalTokens":150}}
```

SSE contract:
- wire format uses unnamed SSE events with JSON payloads in `data:`
- event order is exactly the execution order produced by the agent
- `text_delta` may occur zero or more times
- `tool_start`/`tool_end` may occur zero or more times
- every `tool_start` for a given `callId` must be followed by exactly one `tool_end`
- `done` is always terminal
- `error` is terminal
- `done` and `error` are mutually exclusive
- heartbeats may be sent as SSE comments (`: ping`) and must be ignored by the platform
- the platform may ignore unknown or malformed nonterminal events in MVP, but a valid terminal `done` or `error` is still required

### Errors

| Case | Status | Body |
|------|--------|------|
| Invalid HMAC | `401` | `{ "error": "unauthorized" }` |
| Replay rejected | `401` | `{ "error": "replay_rejected" }` |
| Duplicate in-flight `request_id` on same instance | `409` | `{ "error": "request_in_progress" }` |
| Invalid request shape | `422` | `{ "error": "invalid_request" }` |
| Queue full | `429` | `{ "error": "queue_full" }` |
| Turn failed | `500` | `{ "error": "turn_failed" }` |

---

## 10. Security

Primary trust boundary:
- platform ↔ agent via HMAC-authenticated requests

The agent validates:
- signature and timestamp
- payload schema
- maximum message length
- maximum supplied history length / token budget

Platform-side expectations:
- the platform may continue consuming the turn even if the fan client disconnects
- the platform persists only final delivered assistant text in durable conversation history
- hidden reasoning and intermediate tool chatter are runtime-only and are not required to be persisted by the platform

The agent does **not** implement:
- user auth
- moderation policy
- billing checks
- durable idempotency

Those belong to the platform.

### Duplicate request behavior

The platform owns durable idempotency. The agent only provides best-effort in-process protection:
- if the same `request_id` arrives again while it is already active in the same process, return `409 request_in_progress`
- if the same `request_id` is still pending in the same process queue, return `409 request_in_progress`
- after completion, the agent makes no durable replay guarantee; the platform must suppress duplicates
- after process restart, the agent has no memory of prior `request_id` values

---

## 11. Storage

The agent has no required conversation database in MVP.

Required persistent state:
- creator deployment config (`config.yaml` + env vars)

Optional local state:
- health snapshots
- debug logs
- transient metrics

System of record owned by the platform:
- users
- conversations
- messages
- moderation
- usage/billing
- idempotency

---

## 12. Scaling Strategy

### Single instance limits

```text
Concurrent active turns: ~50-100
Primary bottleneck: model provider rate limits
Memory bottleneck: active conversation cache + supplied history + stream buffers
```

### MVP deployment rule

MVP requires **one agent instance per creator deployment**.

Reason:
- FIFO ordering by `conversation_id` is implemented in-process
- no distributed conversation lock or affinity mechanism exists in MVP

This is an MVP constraint, not a permanent architecture rule.

### Horizontal scaling

The agent may keep active per-conversation state between requests, so horizontal scaling needs an explicit cache strategy.

Important consequences:
- per-conversation FIFO only holds within one process unless the platform enforces affinity
- agent-side active state is best treated as a disposable cache
- cache misses must fall back to platform-supplied history without correctness loss

Recommended contract:
- MVP: one agent instance per creator deployment
- Scale: platform manages routing/affinity for `conversation_id`, or the agent accepts cold-start reseeding on any instance

### Heartbeats

In MVP, the agent should proactively report liveness to the platform rather than waiting for platform polling.

Recommended behavior:
- agent sends periodic heartbeat requests to the platform every 15-30 seconds
- platform updates `last_heartbeat_at`
- platform marks the agent offline when heartbeat age exceeds the configured stale threshold
- real request failures may also cause earlier offline marking

---

## 13. Configuration

### `config.yaml`

```yaml
persona:
  name: "Agent Name"
  system_prompt: |
    You are a helpful assistant representing the creator.
    Be friendly and informative.
  model: gpt-4o
  model_provider: openai
  tools:
    allow_web_search: true

server:
  port: 8080
  bind: "0.0.0.0"

auth:
  api_key: ${DIGITALME_API_KEY}
  signing_secret: ${DIGITALME_SIGNING_SECRET}

model:
  api_key: ${MODEL_API_KEY}

limits:
  max_message_length: 4000
  max_history_messages: 100
  max_turns: 10
  max_concurrent: 50
  max_pending: 1000

security:
  hmac_tolerance_seconds: 300
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DIGITALME_API_KEY` | Yes | Platform API key |
| `DIGITALME_SIGNING_SECRET` | Yes | Platform signing secret |
| `MODEL_API_KEY` | Yes | LLM provider API key |
| `DIGITALME_PORT` | No | Server port |

---

## 14. Deployment

### Dockerfile

```dockerfile
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY dist ./dist

EXPOSE 8080

ENV NODE_ENV=production
ENV DIGITALME_PORT=8080

CMD ["node", "dist/index.js"]
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  agent:
    build: .
    ports:
      - "8080:8080"
    environment:
      - DIGITALME_API_KEY=${DIGITALME_API_KEY}
      - DIGITALME_SIGNING_SECRET=${DIGITALME_SIGNING_SECRET}
      - MODEL_API_KEY=${MODEL_API_KEY}
    volumes:
      - ./config.yaml:/app/config.yaml:ro
    restart: unless-stopped
```

---

## 15. Implementation Checklist

### Recommended implementation sequence

1. Pin the BrowserX source commit SHA and document it in the new repo.
2. Extract and compile the model layer with dependency pruning before wiring any HTTP routes.
3. Implement `/health`, `/verify`, HMAC validation, and basic config loading.
4. Implement `Agent`, `SubmissionQueue`, and `TurnExecutor` around the `POST /v1/turn` contract.
5. Add `ActiveConversationManager` for per-conversation derived state, cache eviction, and reseed handling.
6. Add SSE streaming, terminal event guarantees, and provider/tool smoke tests.
7. Integrate with the platform after platform-side local conversation persistence exists.
8. Add proactive heartbeat support and deployment documentation.

### Phase 1: Project setup

- [ ] Create repository
- [ ] Initialize npm project with TypeScript
- [ ] Add dependencies: `hono`, `zod`, `uuid`
- [ ] Set up build (`tsup` or `esbuild`)
- [ ] Create config loader with Zod validation

### Phase 2: Model/runtime extraction

- [ ] Copy BrowserX model clients
- [ ] Prune BrowserX model-layer dependencies
- [ ] Compile and smoke-test extracted clients
- [ ] Implement `TurnExecutor`
- [ ] Implement tool registry

### Phase 3: Agent core

- [ ] Implement `Agent`
- [ ] Implement `SubmissionQueue` with FIFO per `conversation_id`
- [ ] Implement `EventQueue`
- [ ] Implement cancellation and drain behavior
- [ ] Implement `ActiveConversationManager`
- [ ] Define cache eviction / TTL behavior
- [ ] Define cold-start reseed behavior from platform history

### Phase 4: HTTP protocol

- [ ] Implement HMAC middleware
- [ ] Implement request schema validation
- [ ] Implement `/health`
- [ ] Implement `/verify`
- [ ] Implement `POST /v1/turn` with SSE
- [ ] Implement payload limits (`max_message_length`, `max_history_messages`)

### Phase 5: Verification and deployment

- [ ] Unit tests for HMAC, queueing, tool execution, and retry behavior
- [ ] Integration test for full turn cycle
- [ ] Create Dockerfile
- [ ] Create docker-compose.yml
- [ ] Test against DigitalMe platform
- [ ] Document deployment

### Future phases

- [ ] Restricted MCP integration
- [ ] Richer platform-supplied context fragments
- [ ] Optional execution telemetry sink
- [ ] Multi-instance sequencing contract with platform
- [ ] Incremental history sync contract for hot conversations

---

## Appendix: Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Repo shape | New repo | Clean boundary from BrowserX and platform |
| Runtime role | Agent = executor | Platform keeps coordinator responsibilities |
| Persistence | Platform-owned canonical log | Agent may keep derived active memory without becoming authoritative |
| Concurrency | FIFO within conversation, concurrent across conversations | Preserves order without user-aware runtime |
| Language | TypeScript | BrowserX reuse and fast iteration |
| Tool policy | Static allowlist | No dynamic/untrusted tool registration |
