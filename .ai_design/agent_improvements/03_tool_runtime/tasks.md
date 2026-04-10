# Tasks: Tool Runtime

Source: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

This track turns tool execution into a first-class runtime subsystem.
The task list below is intentionally comprehensive: it covers the execution
boundary, policy boundary, result rendering/budgeting, concurrency, testing,
and rollout invariants described in the design doc.

---

## Step 1: Extract ToolExecutor + Policy Boundary (serial only)

### New files

- [ ] Create `src/tools/execution/ToolExecutor.ts`.
- [ ] Create `src/tools/execution/ToolPolicyChecker.ts`.
- [ ] Create `src/tools/execution/types.ts`.
- [ ] Create `src/tools/execution/index.ts` if the codebase prefers barrel exports.

### Execution types

- [ ] Add `ToolErrorCategory` to `src/tools/execution/types.ts`:
  - `validation_error`
  - `policy_rejected`
  - `timeout`
  - `execution_error`
  - `aborted`
  - `unknown_tool`
- [ ] Add `NormalizedToolResult` with:
  - `success`
  - `truncated`
  - `originalChars`
  - `errorCategory?`
- [ ] Add `ToolExecutionRecord` with:
  - `callId`
  - `toolName`
  - `args`
  - `result`
  - `modelContent`
  - `durationMs`
  - `summary`
- [ ] Add `ToolPolicyDecision` with `allowed` and optional `reason`.
- [ ] Add any internal parsed-call type used by the executor for Phase 1 / Phase 2 processing.

### Policy boundary

- [ ] Add `IToolPolicyChecker` to `src/tools/execution/ToolPolicyChecker.ts`.
- [ ] Define `checkPolicy(toolName, policyCategory, args, context): ToolPolicyDecision`.
- [ ] Add `DefaultToolPolicyChecker` that always returns `{ allowed: true }`.
- [ ] Keep policy state executor-owned, not tool-owned.
- [ ] Document in code comments that policy checks run before batch execution and do not require concurrent access safety.

### ToolExecutor skeleton

- [ ] Add `ToolExecutorCallbacks` with `onToolStart` and `onToolEnd`.
- [ ] Make `ToolExecutor` constructor accept `IToolRegistry` and `IToolPolicyChecker`.
- [ ] Add `runTools(calls, context, budget, callbacks)` entry point.
- [ ] Add `runSingleTool(...)` helper.
- [ ] Keep Step 1 serial-only even if batch helpers are stubbed for later steps.
- [ ] Ensure all tools go through `ToolExecutor`; no direct dispatch remains in `TurnExecutor`.

### TurnExecutor integration

- [ ] Update `src/agent/TurnExecutor.ts` to construct or receive a `ToolExecutor`.
- [ ] Update `TurnExecutorDeps` to optionally inject a policy checker and/or tool executor if useful for tests.
- [ ] Replace inline tool dispatch loop with `toolExecutor.runTools(...)`.
- [ ] Keep `tool_start` and `tool_end` event emission via callbacks.
- [ ] Keep `TurnState.registerToolCall()` / `resolveToolCall()` integration in callback wiring.
- [ ] Delete `TurnExecutor.executeTool()`.
- [ ] Keep `toolCallCount` behavior unchanged.
- [ ] Preserve prompt-history message shape:
  - `role: 'tool'`
  - `content: record.modelContent`
  - `toolCallId`
  - `toolName`

### Step 1 validation

- [ ] No tool is executed directly from `TurnExecutor`.
- [ ] `ToolExecutor` is the only path that calls `tool.execute(...)`.
- [ ] `DefaultToolPolicyChecker` is wired and used.
- [ ] Existing behavior remains unchanged for the current single `web_search` tool.
- [ ] Unknown tool names produce a `ToolExecutionRecord` / tool error path rather than crashing the entire turn unexpectedly.
- [ ] Existing tests still pass after extraction.

---

## Step 2: Richer Tool Interface + Structured Results + Registry Refactor

### Extend tool types

- [ ] Update `src/tools/types.ts` with `ToolPolicyConfig`.
- [ ] Add `ToolContext.policyConfig`.
- [ ] Make `ToolContext.signal` required.
- [ ] Keep `ToolContext.conversationId`.
- [ ] Change `ToolExecutionResult` from string-only content to:
  - `success`
  - `data`
  - `renderForModel(): string`
- [ ] Add `ToolMetadata` with:
  - `timeoutMs`
  - `maxResultChars`
  - `policyCategory`
- [ ] Add `DEFAULT_TOOL_METADATA`.
- [ ] Extend `Tool<TInput>` with:
  - `name`
  - `definition`
  - `metadata`
  - `inputSchema`
  - `execute(args, context)`
  - optional `isConcurrencySafe(args)`
  - optional `validateInput(args, context)`
  - optional `summarizeResult(args, result)`

### Runtime typing boundary

- [ ] Keep registry storage consistent with the chosen design:
  - either bare `Tool` with default generic params
  - or an explicit erased runtime type alias if implementation clarity improves
- [ ] Keep the executor responsible for schema parsing before `execute(...)`.
- [ ] Keep any executor-side cast localized to one boundary only.
- [ ] Do not spread raw `unknown` / `any` tool-input handling throughout the runtime.

### Registry refactor

- [ ] Update `src/tools/registry.ts` so `register(tool)` is public.
- [ ] Reject duplicate tool registration.
- [ ] Keep `listDefinitions()`, `listNames()`, and `get(name)` methods.
- [ ] Extract `createToolRegistry(config)` factory.
- [ ] Remove hardcoded registration from the constructor path.
- [ ] Update `TurnExecutor` construction to use the new registry factory or equivalent setup path.
- [ ] Keep test injection straightforward: callers should be able to create a registry and register fake tools without config gymnastics.

### Zod + schema generation

- [ ] Add `zod` dependency.
- [ ] Add `zod-to-json-schema` or chosen equivalent dependency.
- [ ] Standardize derivation of `ToolDefinition.function.parameters` from `inputSchema`.
- [ ] Keep JSON Schema generation as the single source of truth from Zod definitions.

### WebSearchTool migration

- [ ] Update `src/tools/web-search.ts` to implement the richer `Tool<WebSearchInput>` interface.
- [ ] Add `metadata` with:
  - `timeoutMs: 5_000`
  - `maxResultChars: 4_000`
  - `policyCategory: 'search'`
- [ ] Add `inputSchema` with `query: z.string().min(1).max(500)`.
- [ ] Replace manual `typeof args.query === 'string'` validation with schema-based parsing.
- [ ] Move timeout/abort composition out of the tool and into the executor.
- [ ] Keep the tool focused on fetching/parsing upstream data.
- [ ] Return structured `data` for search results.
- [ ] Implement `renderForModel()` for search result text rendering.
- [ ] Implement `isConcurrencySafe()` and return `true`.
- [ ] Implement `summarizeResult()` with a short non-model-facing summary.
- [ ] Preserve existing failure semantics in model-facing text where reasonable:
  - HTTP failure
  - timeout
  - invalid upstream response
  - no useful results

### ToolExecutor runtime behavior

- [ ] Parse raw tool-call JSON arguments before executing tools.
- [ ] Convert JSON parse failures into `validation_error`.
- [ ] Run `tool.inputSchema.safeParse(...)`.
- [ ] Convert schema failures into `validation_error`.
- [ ] Run optional `tool.validateInput(...)` after schema parse.
- [ ] Convert semantic validation failures into `validation_error`.
- [ ] Run `policyChecker.checkPolicy(...)` after validation.
- [ ] Convert policy denials into `policy_rejected` records.
- [ ] Call `tool.execute(parsedArgs, context)` only after parse, validation, and policy pass.
- [ ] Call `result.renderForModel()` and store the rendered value in `record.modelContent`.
- [ ] Ensure summaries are logging/monitoring-facing only, not model-facing.
- [ ] Ensure structured `result.data` is never used as prompt content directly.

### Step 2 validation

- [ ] Every tool has a Zod schema.
- [ ] Invalid tool input is rejected by the executor, not by ad hoc tool logic.
- [ ] `WebSearchTool` returns structured data plus `renderForModel()`.
- [ ] `ToolRegistry.register()` supports runtime/test registration cleanly.
- [ ] Tool definitions exposed to the model are still valid function definitions.

---

## Step 3: Abort/Timeout Handling + Serial Result Budgeting

### ResultBudget file

- [ ] Create `src/tools/execution/ResultBudget.ts`.
- [ ] Add constructor with aggregate max total chars defaulting to `80_000`.
- [ ] Add `truncateAndConsume(content, perToolMax)`.
- [ ] Add `normalizeBatch(records)` placeholder or full implementation if landed in this step.
- [ ] Add `remaining` getter.

### Truncation helper

- [ ] Implement `truncateResult(content, maxChars)` in the chosen location.
- [ ] Reserve space for truncation suffix.
- [ ] Add fixed minimal placeholder behavior when the remaining budget is too small.
- [ ] Guarantee returned string never exceeds `maxChars`.
- [ ] Preserve `originalChars`.
- [ ] Set `truncated: true` when content changes.
- [ ] Prefer cutting at a newline boundary when possible.

### Abort signal composition

- [ ] Add shared `createToolAbortSignal(requestSignal, timeoutMs)` helper.
- [ ] Compose per-tool timeout with request abort signal.
- [ ] Clear timer during cleanup.
- [ ] Remove request-signal event listener during cleanup.
- [ ] Distinguish abort reason sufficiently to classify:
  - timeout
  - request abort
- [ ] Ensure cleanup runs on success and failure paths.

### Error classification

- [ ] Map unknown tool to `unknown_tool`.
- [ ] Map JSON/schema/semantic validation failures to `validation_error`.
- [ ] Map policy denial to `policy_rejected`.
- [ ] Map timeout abort to `timeout`.
- [ ] Map request abort to `aborted`.
- [ ] Map all other exceptions to `execution_error`.
- [ ] Keep error strings telemetry-safe and avoid leaking raw sensitive content in summary/log fields.

### Serial-path budget enforcement

- [ ] Create a `ResultBudget` local variable at the top of each `TurnExecutor.run()` call.
- [ ] Pass that budget into `toolExecutor.runTools(...)`.
- [ ] In serial execution, truncate `record.modelContent` against:
  - per-tool `metadata.maxResultChars`
  - aggregate remaining budget
- [ ] Apply truncation to `record.modelContent`, not to structured `result.data`.
- [ ] Reflect truncation status back into `record.result.truncated`.
- [ ] Keep `record.modelContent` as the content that reaches prompt history.

### Step 3 validation

- [ ] Request abort stops tool execution.
- [ ] Per-tool timeout stops long-running tool execution.
- [ ] Timeout classification is distinct from generic abort.
- [ ] Rendered model content is bounded in serial execution.
- [ ] Aggregate budget does not leak across requests.
- [ ] Structured `result.data` remains intact even when model content is truncated.

---

## Step 4: Concurrency Safety Evaluation + Batch Partitioning

### Phase 1 preprocessing

- [ ] Add parsed-call preprocessing step before batching.
- [ ] For each call, do all of the following serially:
  - lookup tool
  - parse raw JSON
  - schema-validate input
  - run `validateInput()`
  - run policy check
  - evaluate `isConcurrencySafe(parsedInput)`
- [ ] Create immediate error records for:
  - unknown tool
  - invalid JSON
  - schema validation failure
  - semantic validation failure
  - policy rejection
- [ ] Exclude failed/rejected calls from execution batching.

### Batching

- [ ] Add `ParsedToolCall` type with at least:
  - original `ToolCall`
  - resolved `tool`
  - parsed input
  - safety flag
- [ ] Add `Batch` type with:
  - `concurrent`
  - `items`
- [ ] Implement `partitionIntoBatches(parsedCalls)`.
- [ ] Group consecutive safe calls into concurrent batches.
- [ ] Ensure unsafe calls run in single-item serial batches.
- [ ] Preserve original model call order at the batch-plan level.
- [ ] Add concurrency cap for concurrent execution.

### Concurrent execution

- [ ] Use `Promise.allSettled()` for concurrent batches.
- [ ] Convert rejected promises into `ToolExecutionRecord`s rather than dropping them.
- [ ] Preserve returned `ToolExecutionRecord[]` in original model call order.
- [ ] Keep real-time event callbacks unbuffered under concurrency.
- [ ] Ensure `tool_start` / `tool_end` callbacks can fire in completion order under concurrency.
- [ ] Document and preserve the distinction:
  - events: real-time completion order
  - returned records: original call order

### Step 4 validation

- [ ] Two safe tool calls in one model step run in parallel.
- [ ] An unsafe tool call always runs alone.
- [ ] Policy-rejected calls do not enter concurrent execution.
- [ ] Invalid-input calls do not enter concurrent execution.
- [ ] The returned record array preserves model call order.
- [ ] Real-time events reflect actual execution timing rather than buffered ordering.

---

## Step 5: Concurrent Aggregate Budget Normalization

### normalizeBatch implementation

- [ ] Implement `ResultBudget.normalizeBatch(records)`.
- [ ] Assume per-tool `maxResultChars` truncation has already been applied to each `record.modelContent`.
- [ ] Compute total current batch size from `record.modelContent`.
- [ ] Apply aggregate budget against `this.consumed + batchTotal`.
- [ ] Truncate largest `record.modelContent` values first until the batch fits.
- [ ] Update `record.modelContent` after each truncation.
- [ ] Reflect truncation back into `record.result.truncated`.
- [ ] Preserve `record.result.originalChars` as the original pre-truncation rendered length.
- [ ] Increment consumed budget after normalization completes.
- [ ] Keep normalization deterministic.

### Invariants

- [ ] Only `modelContent` is aggregate-budgeted.
- [ ] Structured `result.data` is never truncated by aggregate budgeting.
- [ ] Concurrent batch normalization runs after all results in the batch complete.
- [ ] Serial and concurrent paths share the same aggregate budget instance for the request.

### Step 5 validation

- [ ] Concurrent aggregate budgeting keeps prompt content within total budget.
- [ ] Budget enforcement is deterministic under concurrency.
- [ ] Largest-first truncation is covered by tests so future changes are explicit.
- [ ] Later concurrent batches see reduced remaining budget after earlier batches consume it.

---

## Step 6: Session/Prompt Integration for Tool Summaries

### Summary production

- [ ] Ensure every `ToolExecutionRecord` includes `summary`.
- [ ] Use `tool.summarizeResult()` when provided.
- [ ] Add default summary format when no custom summary exists.
- [ ] Keep summary concise and non-sensitive.

### SessionState wiring

- [ ] Update `src/agent/SessionState.ts` to store tool-use summaries alongside prompt history if that is already the chosen storage location.
- [ ] Keep summary storage separate from model-facing tool message content.
- [ ] Ensure current prompt construction remains unchanged unless prompt-work depends on summaries in this track.
- [ ] Document that summaries are for future prompt projection / compaction, not immediate model consumption.

### Step 6 validation

- [ ] Every executed tool call generates a summary.
- [ ] Summaries are available from session state for future prompt work.
- [ ] Summary storage does not change current model prompt behavior unless explicitly intended.

---

## Cross-Cutting Implementation Details

### Construction and dependency injection

- [ ] Decide where default `ToolExecutor` construction lives.
- [ ] Decide where default `DefaultToolPolicyChecker` construction lives.
- [ ] Keep unit tests able to inject:
  - fake registry
  - fake policy checker
  - fake tool implementations

### Config plumbing

- [ ] Thread policy-relevant config into `ToolContext.policyConfig`.
- [ ] Keep `ToolPolicyConfig` narrow and tool-facing.
- [ ] Keep full runtime policy state out of tool context.
- [ ] If new config schema is required for `toolPolicy`, add it to `src/config/schema.ts`.
- [ ] Ensure existing config remains backward compatible if no new tool policy config is set.

### Backward compatibility

- [ ] Existing single-tool conversation flow remains unchanged for users.
- [ ] Existing `ToolDefinition` exposure to the model remains compatible.
- [ ] Existing `promptMessages` / turn result shapes remain unchanged except for tool-runtime internals.

### Code comments and documentation

- [ ] Add short comments in executor code for the major phases:
  - Phase 1: parse/validate/policy
  - Phase 2: batch partition
  - Phase 3: execute
  - Phase 4: aggregate budget
- [ ] Document event-order semantics near callback types.
- [ ] Document that `modelContent` is the only prompt-facing representation.
- [ ] Document that policy checks are serial and executor-owned.

---

## Unit Tests

### ToolExecutor

- [ ] Unknown tool returns `unknown_tool`.
- [ ] Invalid JSON args return `validation_error`.
- [ ] Zod schema failure returns `validation_error`.
- [ ] `validateInput()` rejection returns `validation_error`.
- [ ] Policy rejection returns `policy_rejected`.
- [ ] Timeout maps to `timeout`.
- [ ] Request abort maps to `aborted`.
- [ ] Generic exception maps to `execution_error`.
- [ ] `tool.execute()` is never called for parse/validation/policy failures.
- [ ] `renderForModel()` is called exactly once per successful execution.
- [ ] Default summary generation works.
- [ ] Custom `summarizeResult()` overrides default summary generation.

### ResultBudget / truncation

- [ ] `truncateResult()` leaves short strings unchanged.
- [ ] `truncateResult()` truncates long strings with suffix.
- [ ] `truncateResult()` never returns content longer than `maxChars`.
- [ ] Very small budgets return the minimal placeholder.
- [ ] Newline-aware truncation prefers newline boundaries when available.
- [ ] `truncateAndConsume()` reduces `remaining`.
- [ ] `normalizeBatch()` truncates largest results first.
- [ ] `normalizeBatch()` updates consumed budget correctly.
- [ ] `normalizeBatch()` is deterministic for fixed inputs.

### Abort helper

- [ ] Timer abort fires after `timeoutMs`.
- [ ] Request abort propagates into tool abort signal.
- [ ] Cleanup clears timer.
- [ ] Cleanup removes request abort listener.

### Registry

- [ ] Duplicate registration throws.
- [ ] Registered tools appear in `listDefinitions()`.
- [ ] Registered tools appear in `listNames()`.
- [ ] `get(name)` returns the correct tool.

### WebSearchTool

- [ ] Input schema rejects empty query.
- [ ] `isConcurrencySafe()` returns true.
- [ ] Successful search returns structured data.
- [ ] `renderForModel()` produces text from structured results.
- [ ] Failure responses still produce valid structured result + model rendering.
- [ ] `definition.parameters` matches the Zod schema shape.

---

## Integration Tests

- [ ] Full turn with one tool call:
  - model returns `tool_calls`
  - executor runs tool
  - tool result is pushed into `context.messages`
  - model produces final text
- [ ] `TurnExecutor` emits `tool_start` and `tool_end` around execution.
- [ ] Tool result content added to prompt history equals `record.modelContent`.
- [ ] Result budget is fresh per request.
- [ ] Two concurrent-safe tools complete faster together than serial sum.
- [ ] Concurrent result array preserves call order.
- [ ] Concurrent real-time events reflect completion order.
- [ ] Policy-rejected tool call produces an error record and no execution side effect.
- [ ] Aggregate budget bounds multi-tool prompt content in one turn.
- [ ] Mixed batch sequence works:
  - safe
  - safe
  - unsafe
  - safe
- [ ] Abort during a turn stops in-flight tool work.
- [ ] Existing no-tool turns still work unchanged.

---

## Rollout Order

1. Land ToolExecutor extraction and default policy boundary.
2. Land richer tool interface, typed schemas, structured results, and registry refactor.
3. Land timeout/abort handling and serial result budgeting.
4. Land input-dependent concurrency safety evaluation and batch partitioning.
5. Land concurrent aggregate budget normalization.
6. Land summary persistence hooks for future prompt work.

Do not skip Step 2 contract work before Steps 3-5.
Budgeting and concurrency both depend on the final result model and
`isConcurrencySafe(args)` shape.

---

## Done Criteria

- [ ] `TurnExecutor` no longer dispatches tools directly.
- [ ] `ToolExecutor` is the sole execution path for all tools.
- [ ] Every tool has an input schema and invalid input is rejected before execution.
- [ ] Every tool call passes through the policy checker before execution.
- [ ] Tools return structured data and supply model-facing output via `renderForModel()`.
- [ ] `modelContent` is the only prompt-facing tool output field.
- [ ] Per-tool and per-request budgets are enforced on prompt-facing content.
- [ ] Budget behavior is deterministic under both serial and concurrent execution.
- [ ] Concurrency safety is input-dependent and evaluated after parsing.
- [ ] Safe tools can run concurrently when requested by the model.
- [ ] Event ordering semantics are documented and test-covered:
  - real-time events in completion order under concurrency
  - returned records in original call order
- [ ] Summaries are generated for every tool execution and stored for future prompt work.
- [ ] Existing behavior remains stable for the current `web_search` flow.
