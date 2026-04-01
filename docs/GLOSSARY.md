# Glossary

Terminology used across the DigitalMe agent codebase and protocol.

---

## Conversation

A conversation is the top-level container for an ongoing dialogue between a fan and a creator's agent. It is identified by a `conversation_id` and may span many tasks over time.

A conversation has no explicit start/end in the agent protocol — it begins implicitly when the platform sends the first task for a given `conversation_id`, and it remains active in the agent's memory until the session expires.

**Scope:** Platform + Agent. The platform creates and owns the conversation record. The agent receives the `conversation_id` in each task request and uses it to route to the correct session.

---

## Session

A session is the agent's in-memory representation of a conversation. It holds the conversation state — both the canonical message history (simple role/content pairs) and the enriched prompt history (including tool calls and metadata used by the LLM).

Sessions are keyed by `conversation_id` and managed by `SessionManager`. They are:

- **Created** when the first task arrives for a `conversation_id`
- **Reused** for subsequent tasks in the same conversation
- **Evicted** when idle beyond `session_ttl_seconds` (default: 30 minutes) or when the agent hits `max_active_sessions`

Sessions are not persisted — they exist only in process memory and are lost on restart. When a session is evicted or lost, the platform resends the conversation history in the next task request, and the agent rebuilds the session (this is called "reseeding").

**Scope:** Agent only. The platform has no concept of agent sessions.

**Code:** `SessionState` holds the data, `SessionRuntime` orchestrates task execution within a session, `SessionManager` manages the session lifecycle.

---

## Task

A task is a single unit of work requested by the platform: one user message in, one complete agent response out.

The platform sends a task via `POST /v1/task`. The agent processes it — potentially making multiple LLM calls and tool executions — and streams the response back as SSE events on the same HTTP connection. The connection stays open for the duration of the task.

A task is identified by `request_id` and belongs to a conversation (`conversation_id`). Tasks within the same conversation are processed sequentially by the `SubmissionQueue`.

**Lifecycle:** The platform POSTs → agent validates and queues → agent executes (ReAct loop) → agent streams SSE events → stream ends with `done` or `error` → connection closes.

**Scope:** Platform + Agent. Called "task" in the protocol, route handlers, rollout recording (`task_started`, `task_completed`, `task_failed`), and `SessionState.commitTask()`.

**Code:** `TurnSubmission` is the internal representation. `Agent.submit()` is the entry point. `request_id` is used as `taskId` in telemetry.

---

## Turn

A turn is a single LLM round-trip within a task. Each time the agent calls the model and gets a response, that's one turn.

A simple task (no tool use) completes in 1 turn:

```
Turn 1: LLM generates final text → done
```

A task with tool use takes multiple turns:

```
Turn 1: LLM requests tool call → agent executes tool
Turn 2: LLM sees tool result, requests another tool → agent executes
Turn 3: LLM sees result, generates final text → done
```

Turns are bounded by `max_turns` (default: 10) to prevent runaway loops. If the model keeps requesting tool calls beyond this limit, the task fails with `max_turns_exceeded`.

**Scope:** Agent internal only. The platform never sees individual turns — it only sees the flat stream of SSE events (text deltas, tool start/end, done). Turns are an implementation detail of how the agent fulfills a task.

**Code:** `TurnExecutor` runs the turn loop. `context.turnCount` tracks iterations. `TurnState` records per-task metrics (model turn count, tool call count, token usage).

---

## Summary

```
Conversation (conversation_id)          ← platform-owned, long-lived
 └── Session                            ← agent-side in-memory state for this conversation
      ├── Task 1 (request_id)           ← POST /v1/task, one user message → one response
      │    ├── Turn 1: LLM call         ← internal, may produce tool calls
      │    ├── Turn 2: LLM call         ← after tool results
      │    └── Turn 3: LLM call → done  ← final text produced
      ├── Task 2 (request_id)
      │    └── Turn 1: LLM call → done  ← simple response, no tools
      └── ...
```
