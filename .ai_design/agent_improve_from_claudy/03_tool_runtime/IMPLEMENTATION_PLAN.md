# Tool Runtime

## Goal

Turn tool execution into a first-class runtime subsystem before the tool set expands.

This track should make `digitalme-agent` better at:

- executing tools consistently
- applying shared policy decisions
- handling large results safely
- preparing concise tool-use context for later prompt iterations

## Current State

Today the tool layer is intentionally minimal:

- `src/tools/types.ts`
- `src/tools/registry.ts`
- `src/tools/web-search.ts`
- tool dispatch inside `src/agent/TurnExecutor.ts`

This is correct for MVP, but it will not scale well once more public-facing tools are added.

## Claudy Patterns Worth Borrowing

Relevant source references:

- `/home/rich/dev/study/claudy/src/Tool.ts`
- `/home/rich/dev/study/claudy/src/services/tools/toolOrchestration.ts`
- `/home/rich/dev/study/claudy/src/services/tools/toolExecution.ts`
- `/home/rich/dev/study/claudy/src/services/tools/StreamingToolExecutor.ts`
- `/home/rich/dev/study/claudy/src/services/tools/toolHooks.ts`
- `/home/rich/dev/study/claudy/src/utils/toolResultStorage.ts`

### 1. Tool Definition Metadata

In `claudy`, tools carry more than a name and execute function.

The most useful fields to borrow are:

- input schema
- additional validation
- policy category
- timeout
- result-size budget
- input-dependent concurrency classification
- result mapping
- tool-use summary support

The key insight is that some tool properties depend on the specific input, not only the tool type.

### 2. Tool Execution Infrastructure

The important part is not only metadata. It is the shared execution path.

The execution infrastructure should own:

- validation
- policy checks
- timeout enforcement
- result normalization
- result externalization when large
- post-tool summary generation

### 3. Result Budgeting

`claudy` treats large tool results as a prompt-management problem.

Useful ideas:

- per-tool maximum inline result size
- aggregate result budget at the request/prompt level
- store oversized results externally
- keep a preview/reference inline instead of raw full content

### 4. Tool-Use Summaries

This is especially valuable for `digitalme-agent`.

Instead of asking the model to keep re-reading raw tool output, store a concise summary of:

- which tool ran
- what it found
- what matters next

## Target Design for DigitalMe Agent

### New Modules

- `src/tools/execution/ToolExecutor.ts`
  - the single entrypoint for tool execution
- `src/tools/execution/ToolPolicy.ts`
  - all policy decisions before tool execution
- `src/tools/execution/ToolHooks.ts`
  - shared pre/post execution hooks
- `src/tools/execution/ToolSummaryGenerator.ts`
  - generate concise tool-use summaries
- `src/tools/execution/types.ts`
  - execution metadata and normalized result types

### Existing Files To Change

- `src/tools/types.ts`
- `src/tools/registry.ts`
- `src/tools/web-search.ts`
- `src/agent/TurnExecutor.ts`

## Proposed Tool Definition Shape

Recommended additions to the current tool interface:

- `schema`
- `validateInput(args, context)`
- `timeoutMs`
- `maxInlineResultChars`
- `policyCategory`
- `isConcurrencySafe(args)`
- `mapResult(result)`
- `getToolUseSummary(result)`

These should stay practical, not framework-heavy.

## Proposed Execution Flow

All tools should execute through one path:

1. look up tool
2. parse and validate input
3. apply policy decision
4. run tool with timeout and abort signal
5. normalize result
6. externalize oversized result if needed
7. generate tool summary
8. return both:
   - public event output
   - internal execution metadata

## Suggested Implementation Sequence

### Step 1: Shared ToolExecutor

Files:

- new `src/tools/execution/ToolExecutor.ts`
- update `src/agent/TurnExecutor.ts`

Work:

- move tool dispatch out of `TurnExecutor.ts`
- centralize timeout handling
- centralize abort-signal propagation

Exit criteria:

- no tool is executed directly from `TurnExecutor.ts`

### Step 2: Richer Tool Definitions

Files:

- update `src/tools/types.ts`
- update `src/tools/registry.ts`
- update `src/tools/web-search.ts`

Work:

- add richer metadata fields
- support input-dependent concurrency and validation

Exit criteria:

- tools can express runtime behavior and policy needs through definitions

### Step 3: Result Budgeting

Files:

- `src/tools/execution/ToolExecutor.ts`
- optional `src/agent/ArtifactStore.ts`

Work:

- define inline result-size policy
- store oversized results externally
- return preview/reference objects

Exit criteria:

- large tool results do not automatically bloat future prompt context

### Step 4: Tool-Use Summaries

Files:

- new `src/tools/execution/ToolSummaryGenerator.ts`
- update `src/agent/SessionState.ts`
- update `src/agent/TurnExecutor.ts`

Work:

- generate concise summaries after tool execution
- store them as conversation/runtime artifacts
- make them available to prompt projection

Exit criteria:

- later iterations can rely on tool summaries rather than raw outputs

## Concurrency Strategy

Do not begin with the full `claudy` streaming execution model unless latency demands it.

Recommended order:

1. shared serial execution path
2. input-dependent concurrency safety metadata
3. safe concurrent execution for read-only or non-conflicting tools
4. optional future streaming execution if multiple tools per request become common

## Testing Strategy

Add tests for:

- schema validation and custom validation
- timeout enforcement
- abort propagation
- policy rejection
- large-result externalization
- tool-use summary generation
- concurrency classification behavior

## Risks

- over-engineering the tool layer before enough tools exist
- making tool metadata too abstract to be useful
- introducing concurrency before the runtime state is ready

## Success Criteria

- tool execution is centralized
- all tools pass through shared policy checks
- large results are budgeted or externalized
- concise tool summaries are available for later prompt projection

