# Tasks: Forked Agents and Subagents

Source: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

This track delivers the **infrastructure** for spawning background agents and subagents.
Specific consumers (session memory extraction, compaction) belong in their respective tracks
and are documented here only as examples of how the infrastructure is used.

---

## Step 1: TurnExecutor generator refactor + ExecutionOptions + state versioning

### Generator refactor

- [ ] Convert `TurnExecutor.run()` from `async` to `async *` generator.
- [ ] Replace all `events.push(x)` with `yield x` inside `run()`.
- [ ] Use `return result` for the `TurnExecutionResult` (generator return value).
- [ ] Drop the `events: EventQueue<AgentEvent>` parameter from `run()`.
- [ ] Add `consumeGenerator()` helper to `src/agent/types.ts`.
- [ ] Update `SessionRuntime.execute()` to consume generator via `consumeGenerator()` and forward events to `EventQueue`.
- [ ] Keep `EventQueue` as the SSE bridge between `SessionRuntime` and the HTTP route.

### ExecutionOptions

- [ ] Add `ExecutionOptions` interface (`maxTurns`, `maxOutputTokens`, `model`, `toolRegistry`).
- [ ] Add `options?: ExecutionOptions` parameter to `run()`.
- [ ] Resolve overrides at the top of `run()` via local variables: `options?.X ?? this.config.X`.
- [ ] Replace `this.config.limits.max_turns` with local `maxTurns` in the loop guard.
- [ ] Replace `this.config.model.name` with local `modelName` in `client.generate()`.
- [ ] Replace `this.config.model.max_output_tokens` with local `maxOutputTokens` in `client.generate()`.
- [ ] Replace `this.toolRegistry` with local `toolRegistry` in `listDefinitions()` and `get()` calls.

### Session state versioning

- [ ] Add `private revision = 0` to `SessionState`.
- [ ] Add `getRevision(): number`.
- [ ] Increment `revision` in `commitTask()`.
- [ ] Increment `revision` in `reconcileWithPlatformHistory()` on reseed.
- [ ] Add `addMemories(memories)` — additive, no revision check.
- [ ] Add `compactHistory(summary, startRevision): boolean` — CAS-guarded, returns false if stale.

### Validation

- [ ] Generator yields `text_delta` and `done` events in correct order.
- [ ] Generator yields `tool_start`/`tool_end` events around tool execution.
- [ ] Generator return value contains `TurnExecutionResult`.
- [ ] `ExecutionOptions.maxTurns` overrides config default.
- [ ] `ExecutionOptions.maxOutputTokens` overrides config default.
- [ ] `ExecutionOptions.toolRegistry` overrides the default registry.
- [ ] `ExecutionOptions.model` overrides config default.
- [ ] No options passed -> uses config defaults (backwards compatible).
- [ ] `consumeGenerator` forwards all events via callback and returns the result.
- [ ] Existing `SessionRuntime` -> SSE flow still works end-to-end.
- [ ] Abort signal terminates the generator.
- [ ] `SessionState.revision` increments on `commitTask` and reseed.
- [ ] `compactHistory()` succeeds when revision matches, returns false when stale.
- [ ] `addMemories()` succeeds regardless of revision.

---

## Step 2: ForkedAgent runner (`launchForkedAgent`)

### Implementation

- [ ] Create `src/agent/fork/ForkSemaphore.ts` with `tryAcquire()` / `release()`.
- [ ] Create `src/agent/fork/ForkedAgent.ts` with `launchForkedAgent()`.
- [ ] Create `src/agent/fork/index.ts`.
- [ ] Add `ForkedAgentResult` and `ForkedAgentHandle` to `src/agent/types.ts`.
- [ ] Add `ForkedAgentConfig` (`forkLabel`, `skipTranscript`) to types.
- [ ] Add `LaunchForkedAgentParams` to `ForkedAgent.ts`.
- [ ] Implement: acquire semaphore, return `null` if full.
- [ ] Implement: create child `AbortController` linked to `submission.signal`.
- [ ] Implement: start async promise that calls `consumeGenerator(turnExecutor.run(submission, options), discard)`.
- [ ] Implement: call `onResult` on successful completion only.
- [ ] Implement: release semaphore in single `finally` block (covers success, error, abort).
- [ ] Implement: build `ForkedAgentHandle` with `id`, `forkLabel`, `abort`, `promise`.
- [ ] Implement: call `sessionRuntime.registerForkedAgent(handle)`.

### Validation

- [ ] Fork completes and returns `ForkedAgentResult` with `finalText` and `totalUsage`.
- [ ] `ExecutionOptions` overrides are passed through to `TurnExecutor.run()`.
- [ ] Yielded events are discarded (no SSE side effects).
- [ ] `onResult` is invoked on success.
- [ ] `onResult` is NOT invoked on abort or error.
- [ ] Semaphore is acquired before fork starts.
- [ ] Semaphore is released in `finally` (on success, error, and abort).
- [ ] Returns `null` when semaphore is full (caller skips).
- [ ] Handle is registered on `SessionRuntime` and auto-deregistered on promise settlement.
- [ ] Child abort fires when parent signal aborts.
- [ ] Child abort does NOT propagate back to parent.

---

## Step 3: Post-Turn Hooks + Lifecycle integration

### Hook registry

- [ ] Create `src/agent/hooks/PostTurnHooks.ts` with `PostTurnHookRegistry`.
- [ ] Create `src/agent/hooks/index.ts`.
- [ ] Implement `register(hook)` and `unregister(hook)`.
- [ ] Implement `runAll(context)` — sequential execution, errors caught and logged.
- [ ] Add timeout handling in `runAll()` — bounds hook launch, not already-running forks.

### SessionRuntime integration

- [ ] Add `hookRegistry: PostTurnHookRegistry` to `SessionRuntime`.
- [ ] Add `forkSemaphore: ForkSemaphore` to `SessionRuntime`.
- [ ] Add `activeForkedAgents: Map<string, ForkedAgentHandle>` to `SessionRuntime`.
- [ ] Add `registerForkedAgent(handle)` — registers handle, auto-deregisters via `promise.finally`.
- [ ] Add `abortForkedAgents()` — aborts all tracked forks.
- [ ] Add `hasActiveWork()` — returns true if active turn OR active forks.
- [ ] Call `hookRegistry.runAll()` fire-and-forget after `commitResult()` in `execute()`.

### SessionManager integration

- [ ] Update `evictExpiredSessions()` to use `hasActiveWork()` instead of `hasActiveTurn()`.
- [ ] Update `evictExpiredSessions()` to call `abortForkedAgents()` on evicted sessions.
- [ ] Update `beginDrain()` to abort all forked agents across all sessions before setting flag.

### Config

- [ ] Add `forked_agents.enabled` to `agentConfigSchema` (default: `true`).
- [ ] Add `forked_agents.max_concurrent` to `agentConfigSchema` (default: `2`).
- [ ] Add `hooks.post_turn.enabled` to `agentConfigSchema` (default: `true`).
- [ ] Add `hooks.post_turn.timeout_ms` to `agentConfigSchema` (default: `30000`).
- [ ] Thread config into `SessionManager` -> `SessionRuntime` construction.
- [ ] Gate hook execution on `config.hooks.post_turn.enabled`.
- [ ] Gate fork launches on `config.forked_agents.enabled`.

### Validation

- [ ] Hooks run after successful turn completion.
- [ ] Hooks don't block response to user (fire-and-forget).
- [ ] Hook errors are logged and swallowed — never crash the main agent.
- [ ] Hooks can be registered and unregistered.
- [ ] Hook timeout is enforced on launch logic.
- [ ] Session eviction skips sessions with active forked agents.
- [ ] `abortForkedAgents()` cancels all running forks.
- [ ] `beginDrain()` aborts all forked agents across all sessions.
- [ ] Orphaned forks do not survive after drain completes.
- [ ] Disabling hooks via config prevents hook execution.
- [ ] Disabling forked_agents via config prevents fork launches.
- [ ] Config defaults match the plan.

---

## Step 4: Subagent Tool (Phase 2)

### Implementation

- [ ] Create `src/agent/subagent/AgentDefinition.ts` with `AgentDefinition` interface.
- [ ] Create `src/agent/subagent/BuiltInAgents.ts` with default agent type definitions.
- [ ] Create `src/agent/subagent/SubagentTool.ts` — implements `Tool` interface.
- [ ] Create `src/agent/subagent/index.ts`.
- [ ] Implement `resolveSubagentTools()` — intersect with parent, apply denials, never escalate.
- [ ] Register `SubagentTool` in `ToolRegistry` when subagents are enabled.
- [ ] Support model override via `ExecutionOptions.model`.
- [ ] Return subagent `finalText` as tool result to the parent turn.

### Validation

- [ ] Subagent spawns with the specified agent type.
- [ ] Subagent uses its own system prompt (from `AgentDefinition.getSystemPrompt()`).
- [ ] Subagent result is returned to the parent tool call.
- [ ] Subagent tools never exceed parent's tool set.
- [ ] `disallowedTools` removes tools from the resolved set.
- [ ] Model override is respected.

---

## Cross-Cutting Tests

- [ ] Unit tests for `ForkSemaphore`.
- [ ] Unit tests for `PostTurnHookRegistry`.
- [ ] Unit tests for `SessionState` revision behavior.
- [ ] Unit tests for `consumeGenerator`.
- [ ] Integration tests for `launchForkedAgent()` with fake ModelClient.
- [ ] Integration tests for `SessionRuntime` + generator-based executor.
- [ ] Integration tests for drain/eviction behavior with running forks.
- [ ] Regression tests for the normal single-agent flow (no forks, no hooks).

---

## Rollout Order

1. Land generator refactor + ExecutionOptions + state versioning (Step 1).
2. Land fork runtime (Step 2).
3. Land hooks + lifecycle + config (Step 3).
4. Land subagents last (Step 4).

## Done Criteria

- [ ] Main conversation flow is unchanged when forks/hooks are disabled.
- [ ] Background forks never block response streaming.
- [ ] Background fork cleanup works on drain and eviction.
- [ ] Stale fork results cannot corrupt session state (revision CAS guard).
- [ ] Fork and hook behavior is configurable and test-covered.
- [ ] Semaphore release is guaranteed on all code paths (success, error, abort).
- [ ] No orphaned forks after drain.
