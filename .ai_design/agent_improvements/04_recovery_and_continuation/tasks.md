# Tasks: Recovery and Continuation

Source: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

This track makes request execution recovery explicit, bounded, observable, and safe.
It covers:

- API retry with short exponential backoff
- fallback model switching after repeated overload failures
- max-output continuation for truncated responses
- one-shot reactive compaction on context overflow
- continuation/terminal reason tracking
- recovery events in the runtime event stream
- graceful terminal behavior instead of contradictory `done` + thrown-error paths

Implementation rule for this track:

- Keep recovery logic distributed inline in `TurnExecutor` unless a branch becomes too large to read.
- Every recovery path must be explicitly bounded.
- Every extra loop iteration must have a recorded reason.
- Compaction must preserve transcript invariants.
- `max_turns` must terminate gracefully, not by throwing after `done`.

---

## Step 1: Recovery Types and Event Contracts

Everything else depends on these contracts existing first.

### Recovery types

- [ ] Create `src/agent/types/recovery.ts`.
- [ ] Add `ContinuationReason` union:
  - `tool_use`
  - `reactive_compact_retry`
  - `max_output_recovery`
  - `api_retry`
  - `fallback_model`
- [ ] Add `TerminalReason` union:
  - `completed`
  - `max_turns`
  - `prompt_too_long`
  - `model_error`
  - `aborted`
  - `max_output_exhausted`
- [ ] Add `ApiErrorCategory` union:
  - `rate_limit`
  - `overloaded`
  - `server_error`
  - `context_overflow`
  - `auth_error`
  - `unknown`
- [ ] Add `RecoveryState` interface with:
  - `hasAttemptedReactiveCompact`
  - `maxOutputRecoveryCount`
  - `accumulatedText`
  - `apiRetryCount`
  - `fallbackAttempted`
  - `lastTransition`
- [ ] Add `RECOVERY_LIMITS` constant with:
  - `MAX_OUTPUT_RECOVERY_ATTEMPTS = 3`
  - `MAX_API_RETRIES = 3`
  - `FALLBACK_AFTER_CONSECUTIVE_529 = 3`
- [ ] Add `initialRecoveryState()` returning the zeroed initial state.

### Agent event contract

- [ ] Update `src/agent/types.ts` to import `TerminalReason`.
- [ ] Extend `AgentEvent` with:
  - `done` event including optional `terminalReason`
  - `recovery` event including `reason` and optional `detail`
- [ ] Keep existing event variants backwards compatible where possible:
  - `text_delta`
  - `tool_start`
  - `tool_end`
  - `done`
  - `error`
- [ ] Ensure the new `done` event shape still supports `truncated` and `tokenUsage`.

### Validation

- [ ] `RecoveryState` compiles and is importable from executor code.
- [ ] `initialRecoveryState()` returns:
  - `hasAttemptedReactiveCompact = false`
  - `maxOutputRecoveryCount = 0`
  - `accumulatedText = ''`
  - `apiRetryCount = 0`
  - `fallbackAttempted = false`
  - `lastTransition = undefined`
- [ ] `AgentEvent` accepts `recovery` events.
- [ ] `done` events can carry `terminalReason` without breaking existing callers/tests.

---

## Step 2: Config and Model Factory Support for Fallback

The retry/fallback path cannot be implemented cleanly until config and factory support exist.

### Config schema

- [ ] Extract a reusable `modelSchema` in `src/config/schema.ts`.
- [ ] Ensure `modelSchema` includes:
  - `provider`
  - `name`
  - `api_key`
  - `base_url`
  - `max_output_tokens`
- [ ] Replace the inline `model` object with `model: modelSchema`.
- [ ] Add `fallback_model: modelSchema.optional()`.
- [ ] Preserve existing config compatibility when `fallback_model` is absent.

### Model client factory

- [ ] Update `src/models/ModelClientFactory.ts` to support creating non-singleton clients from arbitrary model configs.
- [ ] Add `createFromConfig(modelConfig)` method to `ModelClientFactory`.
- [ ] Ensure `createFromConfig()` supports the same providers as the primary config:
  - `openai`
  - `anthropic`
  - `xai`
  - `groq`
  - `google-ai-studio`
  - `fireworks`
  - `together`
- [ ] Ensure provider-specific base URL defaults still apply for compatible providers.
- [ ] Keep `createClient()` behavior unchanged for the primary singleton client.
- [ ] Extend `IModelClientFactory` to include `createFromConfig(...)`.

### Validation

- [ ] Existing configs without `fallback_model` still parse.
- [ ] Configs with `fallback_model` parse with the same shape as `model`.
- [ ] `createClient()` still returns the singleton primary client.
- [ ] `createFromConfig()` returns a fresh client instance for the provided model config.
- [ ] Fallback config can point to a different provider and model than the primary config.

---

## Step 3: API Error Categorization and Backoff Helpers

Retry behavior should be centralized in helpers, not spread across provider clients.

### Helper module

- [ ] Create `src/agent/apiRetry.ts`.
- [ ] Add `categorizeApiError(error): ApiErrorCategory`.
- [ ] Add `exponentialBackoff(attempt): Promise<void>`.

### `categorizeApiError()` behavior

- [ ] Detect `.status` on provider SDK errors via duck typing.
- [ ] Map status codes:
  - `429` -> `rate_limit`
  - `529` -> `overloaded`
  - `413` -> `context_overflow`
  - `401` / `403` -> `auth_error`
  - `>= 500` -> `server_error`
- [ ] Fall back to message-based pattern matching when `.status` is absent.
- [ ] Support both shapes described in the plan:
  - OpenAI SDK errors
  - Google AI SDK errors
- [ ] Default to `unknown` when no known category matches.

### `exponentialBackoff()` behavior

- [ ] Implement `100ms * 2^attempt`.
- [ ] Ensure attempts used by retry logic produce `100ms`, `200ms`, `400ms`.
- [ ] Keep the helper simple and side-effect free except for waiting.

### Validation

- [ ] Unit-test status-based categorization for:
  - `429`
  - `529`
  - `413`
  - `500`
  - `503`
  - `401`
  - `403`
- [ ] Unit-test unknown status or malformed errors -> `unknown`.
- [ ] Unit-test message-based categorization for provider errors without `.status` where applicable.
- [ ] Unit-test backoff timing logic with fake timers.

---

## Step 4: TurnExecutor Recovery Integration

This is the main integration step. It wires recovery into the request loop.

### Executor setup

- [ ] Update `src/agent/TurnExecutor.ts` to import:
  - recovery types/state helpers
  - retry helpers
  - reactive compaction helper
- [ ] Instantiate `const recovery = initialRecoveryState()` at the start of `run()`.
- [ ] Keep existing loop shape, but add recovery paths inline.

### Model call extraction

- [ ] Extract model invocation into `callModelWithRecovery(...)`.
- [ ] Pass:
  - `context`
  - `recovery`
  - `events`
- [ ] Ensure `callModelWithRecovery()` returns either:
  - `ModelStepResult`
  - `{ type: 'context_overflow' }`

### Continuation tracking

- [ ] Set `recovery.lastTransition` on every `continue` path.
- [ ] Record tool-use continuation with tool names.
- [ ] Record reactive compaction continuation.
- [ ] Record max-output continuation with attempt count.
- [ ] Record API retry continuation with attempt count and category.
- [ ] Record fallback-model continuation with source and destination model names.

### Recovery event emission

- [ ] Emit `recovery` events for:
  - `reactive_compact_retry`
  - `max_output_recovery`
  - `api_retry`
  - `fallback_model`
- [ ] Include useful detail payloads where applicable:
  - attempt number
  - error category
  - from/to model names
- [ ] Keep `tool_use` as tracked state only unless the implementation intentionally wants it surfaced as an event.

### Graceful terminal behavior

- [ ] Ensure `done` events include `terminalReason` on all terminal exits.
- [ ] Replace hard throw on max turns with graceful return.
- [ ] Do not emit `done` and then throw `max_turns_exceeded`.
- [ ] Preserve existing `request_aborted` behavior unless this track intentionally changes it.

### Token usage and active turn state

- [ ] Preserve current token usage updates:
  - `context.tokenUsage`
  - `activeTurn?.turnState.setTokenUsage(...)`
- [ ] Preserve current active turn lifecycle around model turns and tool calls.
- [ ] Ensure recovery paths do not break `toolCallCount` accounting.

### Validation

- [ ] Normal final-text flow still yields `text_delta`, then `done`, then returns `TurnExecutionResult`.
- [ ] Normal tool-call flow still yields `tool_start` / `tool_end` correctly.
- [ ] Existing non-recovery behavior remains unchanged when no failures occur.
- [ ] Every non-first loop iteration has a corresponding `lastTransition`.
- [ ] `done` always carries a `terminalReason`.

---

## Step 5: Implement `callModelWithRecovery()`

This helper owns retry/fallback behavior for a single model step.

### Method shape

- [ ] Add `callModelWithRecovery()` as a private method on `TurnExecutor` or extract it cleanly if preferred.
- [ ] Pass through the same request data currently used for `client.generate()`:
  - `model`
  - `messages`
  - `tools`
  - `signal`
  - `systemPromptBlocks`
  - `maxOutputTokens`

### Retry loop

- [ ] Start with the primary client.
- [ ] Track `consecutive529`.
- [ ] Retry only retryable categories:
  - `rate_limit`
  - `overloaded`
  - `server_error`
- [ ] Stop retrying once `attempt` reaches `MAX_API_RETRIES`.
- [ ] Apply `exponentialBackoff(attempt)` before retry continuation.
- [ ] Increment `recovery.apiRetryCount` on retry.
- [ ] Emit `recovery` event for retry attempts.

### Context overflow behavior

- [ ] If error category is `context_overflow`, return `{ type: 'context_overflow' }` instead of throwing.
- [ ] Do not emit a retry event for `context_overflow` inside this helper.
- [ ] Let the outer loop decide whether reactive compaction runs.

### Fallback behavior

- [ ] Trigger fallback only when:
  - category is `overloaded`
  - `consecutive529 >= FALLBACK_AFTER_CONSECUTIVE_529`
  - `this.config.fallback_model` exists
  - `recovery.fallbackAttempted === false`
- [ ] Create the fallback client with `this.modelClientFactory.createFromConfig(...)`.
- [ ] Do not mutate the primary client singleton.
- [ ] Reset retry budget when switching to fallback:
  - reset loop attempt counter
  - reset `consecutive529`
- [ ] Set `recovery.fallbackAttempted = true`.
- [ ] Set `recovery.lastTransition` to `fallback_model`.
- [ ] Emit `recovery` event describing the model switch.

### Non-retryable / exhausted behavior

- [ ] Throw the original error for:
  - `auth_error`
  - `unknown`
  - retryable categories after retries are exhausted
- [ ] Preserve error identity when possible so upstream logs remain useful.
- [ ] Only use synthetic `api_retries_exhausted` error if the implementation truly cannot rethrow the original error.

### Validation

- [ ] 429 twice then success -> helper returns success after 2 retry events.
- [ ] 5xx then success -> helper retries and succeeds.
- [ ] 413 -> helper returns `context_overflow`.
- [ ] 401/403 -> helper throws immediately.
- [ ] 529 three times with fallback configured -> helper switches client and gives fallback a fresh retry budget.
- [ ] Fallback happens at most once per request.
- [ ] Retry events appear in event stream in the same order retries happen.

---

## Step 6: Max-Output Continuation

This step implements bounded continuation when the model stops due to output limits.

### Recovery behavior

- [ ] Detect `result.type === 'final_text' && result.truncated`.
- [ ] If recovery attempts remain:
  - increment `recovery.maxOutputRecoveryCount`
  - push partial assistant text into `context.messages`
  - append partial text to `recovery.accumulatedText`
  - push continuation user message: `Output limit reached. Resume exactly where you stopped.`
  - set `recovery.lastTransition`
  - emit `recovery` event
  - `continue`
- [ ] If recovery attempts are exhausted:
  - append final partial text to `recovery.accumulatedText`
  - emit `done` with `terminalReason: max_output_exhausted`
  - return final text built from the accumulated partials

### Final completion behavior

- [ ] On normal non-truncated final text, prepend `recovery.accumulatedText` to the final chunk.
- [ ] Return the concatenated text in the final `TurnExecutionResult`.
- [ ] Keep the design's documented trade-off:
  - use blind concatenation
  - do not add suffix-overlap dedupe in this track
- [ ] If desired, note the trade-off in code comments near the continuation path.

### Transcript invariants

- [ ] Ensure the resumed call sees the partial assistant text in `context.messages`.
- [ ] Ensure partial text is preserved even if the final terminal outcome is `max_turns` or `max_output_exhausted`.
- [ ] Do not lose partial text between successive continuation attempts.

### Event behavior

- [ ] Decide whether partial chunks should also be emitted as `text_delta` immediately before continuation.
- [ ] Keep the behavior internally consistent with current streaming semantics and tests.
- [ ] If partial chunks are emitted, ensure the final returned text is still full concatenation.
- [ ] If partial chunks are not emitted, ensure the final user-visible output still contains the full text by the end.

### Validation

- [ ] Truncated response followed by successful continuation returns full concatenated text.
- [ ] Multiple truncations accumulate correctly across 2-3 iterations.
- [ ] `max_output_recovery` events include attempt numbers.
- [ ] Recovery stops after `MAX_OUTPUT_RECOVERY_ATTEMPTS`.
- [ ] `max_output_exhausted` terminal reason is emitted on exhaustion.
- [ ] Blind concatenation behavior is explicitly test-covered so future dedupe changes are deliberate.

---

## Step 7: Reactive Compaction for 413 / Context Overflow

This is a minimal first pass, but transcript integrity is non-negotiable.

### Helper module

- [ ] Create `src/agent/reactiveCompact.ts`.
- [ ] Export `groupByRound(messages)` helper.
- [ ] Export or expose compaction entry point used by `TurnExecutor`.

### Grouping behavior

- [ ] Group `context.messages` into complete request/response rounds.
- [ ] Preserve the system prompt as its own first group.
- [ ] Start a new round on each `user` message.
- [ ] Include in the current round:
  - the user message
  - the assistant reply
  - all tool result messages associated with that reply
- [ ] Match the plan example:
  - `[system]`
  - `[user1, assistant1, tool1a, tool1b]`
  - `[user2, assistant2]`
  - `[user3, assistant3]`

### Compaction behavior

- [ ] Implement minimal drop-middle strategy:
  - keep first group (system prompt)
  - keep last 2 round groups
  - drop complete round groups in the middle
- [ ] Return `false` when there is not enough history to compact meaningfully.
- [ ] Guard the recovery path with `recovery.hasAttemptedReactiveCompact`.
- [ ] Mark `hasAttemptedReactiveCompact = true` only when compaction actually runs.

### Executor integration

- [ ] In the main loop, when result is `context_overflow`:
  - attempt compaction once
  - emit `reactive_compact_retry` event on success
  - set `recovery.lastTransition`
  - `continue`
- [ ] If compaction is unavailable or already attempted:
  - emit `done` with `terminalReason: prompt_too_long`
  - return gracefully instead of continuing indefinitely

### Transcript invariants

- [ ] Never split an assistant tool-call message from its tool result messages.
- [ ] Never split a user request from its assistant response.
- [ ] Never leave orphaned `tool` messages.
- [ ] Never leave orphaned assistant `toolCalls` without matching tool results.
- [ ] Preserve the most recent context by keeping the last two rounds.

### Token-awareness note

- [ ] If token counting is stubbed or deferred, keep the implementation aligned with the plan's “minimal first pass”.
- [ ] Do not over-design proactive compaction in this track.
- [ ] Leave richer compaction/summarization to the context-management track.

### Validation

- [ ] Grouping helper returns expected groups for representative transcripts.
- [ ] Compaction drops whole rounds only.
- [ ] 413 + compactable transcript -> compaction runs once, loop retries.
- [ ] 413 + already compacted once -> `prompt_too_long`.
- [ ] Very short transcript -> compaction returns `false`.
- [ ] After compaction, transcript still satisfies provider message ordering rules.

---

## Step 8: Terminal Reason Semantics and Graceful Degradation

The runtime must not signal completion and failure for the same request.

### Terminal exits

- [ ] Ensure all terminal loop exits map to a `TerminalReason`.
- [ ] Cover at least:
  - `completed`
  - `max_turns`
  - `prompt_too_long`
  - `max_output_exhausted`
  - `model_error`
  - `aborted`

### `max_turns`

- [ ] Replace current `throw new Error('max_turns_exceeded')` path with graceful return.
- [ ] Emit `done` with `terminalReason: max_turns`.
- [ ] Return a coherent `TurnExecutionResult` even if only `recovery.accumulatedText` exists.
- [ ] Decide and document whether `truncated: true` should be set on `max_turns` completion.

### Unrecoverable model errors

- [ ] Decide where `model_error` terminal reason is attached:
  - in `TurnExecutor` before rethrow
  - or by converting errors to terminal returns
- [ ] Keep semantics consistent with `SubmissionQueue`, which currently turns thrown errors into `error` events.
- [ ] If this track does not fully normalize unrecoverable errors into `done`, document that clearly and keep tests aligned.

### Abort behavior

- [ ] Confirm whether this track changes abort handling.
- [ ] If abort remains a thrown `request_aborted`, tests should continue to expect rejection.
- [ ] If abort is normalized into `TerminalReason.aborted`, update executor and queue behavior together.
- [ ] Avoid mixed semantics where some terminal paths emit `done` and others emit `done` + `error` for the same case.

### Validation

- [ ] `max_turns` no longer produces a contradictory `done` followed by `error`.
- [ ] `SubmissionQueue` sees graceful `max_turns` requests as non-failed.
- [ ] Terminal reason behavior is documented and test-covered for all non-exceptional terminal paths.

---

## Step 9: Tests

This track touches control flow, event contracts, and transcript shape. Test breadth matters.

### Unit tests

- [ ] Add tests for `initialRecoveryState()`.
- [ ] Add tests for `categorizeApiError()`.
- [ ] Add tests for `exponentialBackoff()` with fake timers.
- [ ] Add tests for `groupByRound()`.
- [ ] Add tests for minimal compaction helper.
- [ ] Add tests for `callModelWithRecovery()` with fake clients/factory.
- [ ] Add tests for max-output accumulation behavior.
- [ ] Add tests for `AgentEvent` / `done.terminalReason` typings where appropriate.

### TurnExecutor tests

- [ ] Update `src/agent/TurnExecutor.test.ts`.
- [ ] Add scenario: plain final text -> unchanged success behavior.
- [ ] Add scenario: tool call then final text -> unchanged success behavior.
- [ ] Add scenario: 429 twice then success -> retry events observed.
- [ ] Add scenario: 529 three times then fallback success.
- [ ] Add scenario: truncated output then successful continuation.
- [ ] Add scenario: multiple truncations accumulate correctly.
- [ ] Add scenario: truncated output exhausts attempts -> `max_output_exhausted`.
- [ ] Add scenario: 413 then successful compaction retry.
- [ ] Add scenario: 413 after prior compaction -> `prompt_too_long`.
- [ ] Add scenario: `max_turns` returns gracefully with terminal reason.
- [ ] Preserve or intentionally update abort tests.

### Submission/runtime tests

- [ ] Update any tests that assert exact `done` event shapes.
- [ ] Add regression coverage for `SubmissionQueue` so graceful terminal exits do not become `error` events.
- [ ] Update `server.integration.test.ts` if SSE payload snapshots assume old `done` shape.
- [ ] Update any subagent/fork/runtime tests affected by the widened `AgentEvent` union.

### Transcript invariant tests

- [ ] Verify partial assistant text is preserved in `context.messages` across max-output continuation.
- [ ] Verify `recovery.accumulatedText` matches concatenation of all partial chunks.
- [ ] Verify compaction never splits assistant tool-call and tool-result pairs.
- [ ] Verify compaction never separates user request and assistant response.
- [ ] Verify post-compaction transcript remains valid for model client consumption.

### Observability tests

- [ ] Verify `recovery` events are emitted in correct order.
- [ ] Verify retry events include attempt and error type.
- [ ] Verify fallback events include from/to model names.
- [ ] Verify `done` always includes `terminalReason`.
- [ ] Verify `lastTransition` matches the actual continuation reason.

---

## Step 10: Cleanup, Compatibility, and Documentation

### Code cleanup

- [ ] Keep recovery branches readable; extract only if a branch becomes too large.
- [ ] Avoid introducing a centralized `RecoveryManager`.
- [ ] Keep comments focused on non-obvious invariants:
  - blind concatenation trade-off
  - fresh retry budget on fallback
  - round-preserving compaction

### Compatibility review

- [ ] Audit all consumers of `AgentEvent` for compatibility with:
  - `recovery` events
  - `done.terminalReason`
- [ ] Audit all tests using exact event arrays.
- [ ] Audit any code assuming `max_turns` throws.

### Developer-facing documentation

- [ ] Update or add inline code comments documenting:
  - why fallback creates a new client instead of mutating the old one
  - why compaction groups by request/response round
  - why blind concatenation is acceptable in v1
- [ ] If the repo has operational docs for config, mention `fallback_model`.

### Validation

- [ ] No dead code remains from the old hard-fail `max_turns` path.
- [ ] Recovery behavior is understandable from code structure and tests.
- [ ] New config field is discoverable and documented where appropriate.

---

## Rollout Order

1. Land recovery types and event contract changes.
2. Land config + factory support for `fallback_model`.
3. Land retry helpers (`categorizeApiError`, `exponentialBackoff`).
4. Land `TurnExecutor` integration and `callModelWithRecovery()`.
5. Land max-output continuation.
6. Land reactive compaction.
7. Land terminal reason cleanup and graceful `max_turns`.
8. Land test updates and regression coverage.
9. Do a final compatibility sweep for event consumers and configs.

## Done Criteria

- [ ] Every loop iteration beyond the first has a recorded continuation reason.
- [ ] Every non-exceptional terminal exit emits `done` with `terminalReason`.
- [ ] API errors `429`, `529`, and `5xx` retry with bounded backoff.
- [ ] Fallback model switching is supported, bounded, observable, and uses a fresh retry budget.
- [ ] Truncated outputs continue automatically up to the configured bound.
- [ ] Partial text is preserved across continuation attempts and included in the final result.
- [ ] Context overflow triggers at most one reactive compaction attempt.
- [ ] Compaction preserves request/response and tool-call transcript invariants.
- [ ] `max_turns` degrades gracefully instead of producing contradictory completion/error signaling.
- [ ] Recovery events are visible in the event stream and rollout recordings.
- [ ] Existing no-error request latency and behavior are not regressed.
- [ ] Tests cover the normal path, recovery paths, and transcript invariants.
