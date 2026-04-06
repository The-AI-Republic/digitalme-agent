# Internal Events and Observability

## Goal

Improve operational visibility without changing the external SSE protocol.

This track should make `digitalme-agent` better at:

- debugging request execution
- measuring tool/runtime behavior
- supporting future internal hook points

## Current State

Today the public-facing stream is intentionally small:

- `text_delta`
- `tool_start`
- `tool_end`
- `done`
- `error`

This is correct for the platform relay, but it is too small for deep internal observability.

## Claudy Patterns Worth Borrowing

Relevant source references:

- `/home/rich/dev/study/claudy/src/query.ts`
- `/home/rich/dev/study/claudy/src/services/tools/toolHooks.ts`
- `/home/rich/dev/study/claudy/src/state/onChangeAppState.ts`

Useful ideas:

- internal lifecycle events are richer than public output
- hook points can attach to lifecycle stages later
- observability should distinguish request lifecycle from tool lifecycle from continuation/recovery lifecycle

## Target Design for DigitalMe Agent

### New Modules

- `src/agent/types/internal-events.ts`
  - internal event union
- optional `src/agent/InternalEventBus.ts`
  - only if a local bus genuinely simplifies wiring

### Existing Files To Change

- `src/agent/types.ts`
- `src/agent/Agent.ts`
- `src/agent/SessionRuntime.ts`
- `src/agent/TurnExecutor.ts`
- `src/agent/RolloutRecorder.ts`

## Suggested Internal Event Set

### Request Lifecycle

- `request_received`
- `request_admitted`
- `request_rejected`
- `turn_started`
- `turn_completed`
- `turn_failed`

### Iteration Lifecycle

- `iteration_started`
- `iteration_completed`
- `continuation_requested`
- `recovery_triggered`

### Tool Lifecycle

- `tool_started`
- `tool_completed`
- `tool_failed`
- `tool_externalized`
- `tool_summary_stored`

### State/Health Lifecycle

- `session_reseeded`
- `session_evicted`
- `heartbeat_started`
- `heartbeat_failed`

## Observer vs Event Bus

Prefer this order:

1. direct structured lifecycle calls
2. `RuntimeObservers` consuming those events
3. only add a bus if multiple consumers justify it

Do not start with a generic event bus if it only adds indirection.

## Suggested Implementation Sequence

### Step 1: Internal Event Types

Files:

- new `src/agent/types/internal-events.ts`
- update `src/agent/types.ts`

### Step 2: Emit Events from Core Runtime

Files:

- `src/agent/Agent.ts`
- `src/agent/SessionRuntime.ts`
- `src/agent/TurnExecutor.ts`

Work:

- emit request, iteration, and tool lifecycle events

### Step 3: Connect Observability Sinks

Files:

- `src/agent/RolloutRecorder.ts`
- `src/agent/RuntimeObservers.ts`

Work:

- feed rollout logs
- feed metrics/debug counters
- keep public SSE unchanged

## Testing Strategy

Add tests for:

- event emission order
- no duplicate emission on one lifecycle transition
- correct event payloads for success and failure

## Risks

- building an event system before there are real consumers
- duplicating data already present in transcript records

## Success Criteria

- internal runtime visibility is much richer than the external SSE stream
- future hooks or diagnostics can attach cleanly
- the public platform contract stays unchanged

