# Tool Runtime

## Goal

Turn tool execution into a first-class runtime subsystem before the tool set expands.

This track should make `digitalme-agent` better at:

- executing tools consistently through a single path
- applying shared policy decisions (rate limits, content moderation, creator config)
- handling large results safely (budget, truncate, externalize)
- preparing concise tool-use context for later prompt iterations
- running safe tools concurrently when the model requests multiple tool calls

## Current State

The tool layer is intentionally minimal:

| File | Role |
|---|---|
| `src/tools/types.ts` | `Tool`, `ToolContext`, `ToolDefinition`, `ToolExecutionResult` interfaces |
| `src/tools/registry.ts` | `ToolRegistry` — config-driven Map, hardcoded WebSearchTool registration |
| `src/tools/web-search.ts` | `WebSearchTool` — DuckDuckGo Instant Answer, 5s timeout, string result |
| `src/agent/TurnExecutor.ts` | ReAct loop with inline tool dispatch (lines 89-114) |

### What works

- Clean separation: `TurnExecutor` owns the loop, tools are looked up by name.
- Abort signal propagation from request → model call → tool execution.
- `TurnState` tracks pending/resolved tool call IDs for monitoring.
- `SessionState.promptHistory` preserves tool interactions across turns.

### What will not scale

1. **Inline dispatch** — `TurnExecutor.executeTool()` is 14 lines of JSON-parse-then-call. Every cross-cutting concern (validation, timeout, policy, result budgeting) would have to be grafted onto this method.
2. **No input validation** — arguments are `Record<string, unknown>` parsed from raw JSON. Invalid input is caught only by the tool itself or not at all.
3. **String-only results** — `ToolExecutionResult.content` is a plain string. No structured data, no metadata about result size or truncation.
4. **Sequential execution** — tool calls are processed in a `for` loop. Multiple read-only calls in one model step block each other.
5. **No result budgeting** — every tool result goes verbatim into prompt history. A large search result bloats all future turns.
6. **Hardcoded registration** — adding a tool requires editing `ToolRegistry` constructor.
7. **Minimal context** — tools receive only `conversationId` and `signal`. No access to config, rate-limit state, or creator policy.

## Claudy Architecture Reference

Claudy is a general-purpose coding agent. Its tool system is much larger than what digitalme-agent needs, but several architectural patterns are directly applicable. This section documents how claudy's tool execution actually works end-to-end, so we can borrow the right shapes without the scale.

### How Tools Integrate with the Agent Loop

Claudy's agent loop lives in `query.ts` (`queryLoop()`, ~1,100 lines). The tool system is cleanly separated from it — tools are **leaf nodes** that do their work and return data. They never call back into the agent.

The integration flow:

```
queryLoop (query.ts)
  │
  │  1. Call model (streaming)
  │     Model response contains ToolUseBlocks
  │
  │  2. Check: any tool_use blocks?
  │     no  → exit/recovery paths (prompt too long, max tokens, budget)
  │     yes → continue to tool execution
  │
  │  3. Hand tool calls to orchestration layer
  │     ┌──────────────────────────────────────────────────┐
  │     │  runTools(toolUseBlocks, context)                 │
  │     │    → toolOrchestration.ts (async generator)       │
  │     │    → partitions into serial/concurrent batches    │
  │     │    → for each call: toolExecution.ts pipeline     │
  │     │    → yields MessageUpdate { message, newContext } │
  │     └──────────────────────────────────────────────────┘
  │
  │  4. Consume yielded results
  │     for await (const update of toolUpdates):
  │       - yield update.message to output stream
  │       - merge update.newContext back into loop state
  │       - collect tool result messages
  │
  │  5. Loop back to model with:
  │     [...previous messages, ...assistant messages, ...tool results]
  │
  └─ repeat until model responds without tool_use blocks
```

**Key design point:** The boundary between agent loop and tool execution is the `runTools()` async generator. The agent loop doesn't know *how* tools execute (serial vs concurrent, with or without hooks). It just consumes `MessageUpdate` objects.

### The Orchestrator as Async Generator

`toolOrchestration.ts` is an `async function*` that yields `MessageUpdate` objects:

```typescript
type MessageUpdate = {
  message?: Message;           // tool result message for the model
  newContext: ToolUseContext;   // possibly-mutated context to carry forward
};
```

The orchestrator partitions tool calls into batches, runs each batch, and yields results **in the model's original call order** regardless of completion order.

For serial batches, context modifications (from tools that mutate state) are applied immediately between tools. For concurrent batches, context modifications are queued and applied after the batch completes. This prevents concurrent tools from racing over shared context.

```typescript
// Serial: apply context modifier immediately
for await (const update of runToolUse(call, context)) {
  if (update.contextModifier) {
    currentContext = update.contextModifier.modifyContext(currentContext);
  }
  yield { message: update.message, newContext: currentContext };
}

// Concurrent: queue modifiers, apply after batch
const queuedModifiers = {};
for await (const update of runToolsConcurrently(batch, context)) {
  if (update.contextModifier) {
    queuedModifiers[update.toolUseID].push(update.contextModifier);
  }
  yield { message: update.message, newContext: currentContext };
}
// Flush queued modifiers in call order
for (const call of batch) {
  for (const modifier of queuedModifiers[call.id] ?? []) {
    currentContext = modifier(currentContext);
  }
}
yield { newContext: currentContext };
```

### The Tool Execution Pipeline

Each individual tool call goes through `toolExecution.ts` (`runToolUse()` → `checkPermissionsAndCallTool()`). This is ~1,750 lines, but the conceptual pipeline is:

```
1. Lookup tool by name
2. Parse input with Zod schema
3. Run tool.validateInput() — semantic checks beyond schema
4. Backfill observable input — add derived fields for hooks to inspect
5. Run pre-hooks (middleware layer)
   → hooks receive: tool name, tool input, tool_use_id, permission mode
   → hooks can return: allow/deny/ask permission, modified input,
     additional context messages, stop signal
6. Resolve permissions — merge hook decision with rule-based deny/ask checks
   → critical invariant: hook 'allow' does NOT bypass deny rules
7. Execute tool.call(parsedInput, context, onProgress)
   → with per-tool AbortController (timeout + request signal)
   → progress callback for real-time status
8. Run post-hooks
   → hooks receive: tool name, input, output
   → hooks can: modify MCP tool output, add context, block continuation
9. Normalize result
   → map via tool.mapToolResultToToolResultBlockParam()
   → check against per-tool maxResultSizeChars
   → externalize to disk if oversized (2KB preview inline)
   → check against aggregate per-message budget
10. Emit analytics (duration, result size, error type, decision source)
11. Return MessageUpdate with tool result message + optional contextModifier
```

Steps 4-6 and 8 are the hook/permission system — the part we don't need. The rest of the pipeline is what we're borrowing.

### The Hook Middleware Model

Claudy's hooks wrap tool execution like middleware. They are **not inside tools** — they sit between the executor and `tool.call()`.

**Pre-hooks** fire before execution. They receive the tool name and parsed input, and can:
- Provide a permission decision (`allow`, `deny`, `ask`) that layers with rule-based checks
- Replace the tool input (e.g., add default parameters)
- Inject context messages into the conversation
- Block continuation entirely with a stop reason

**Post-hooks** fire after execution. They receive the tool name, input, and output, and can:
- Modify the tool output (MCP tools only)
- Inject additional context messages
- Block further tool execution

**Permission resolution** is the most nuanced part. Multiple sources can weigh in:

```
hook decision + rule-based deny/ask checks + tool.checkPermissions() + user dialog
```

The key invariant: a hook saying "allow" does **not** override a deny rule in settings. This prevents a misconfigured hook from escalating privileges. The layering is:

1. Hook says allow → still check deny/ask rules → deny rule wins
2. Hook says deny → immediate rejection, no further checks
3. Hook says ask or says nothing → normal permission flow

**Why this matters for DigitalMe:** We skip the hook system entirely, but the *layering principle* is relevant. When DigitalMe adds policy checks (rate limits, content moderation), they should layer similarly — a tool-level "this is safe" should not bypass agent-level policy.

### Result Formatting for the Model

After execution, claudy converts tool results into API-ready messages through `tool.mapToolResultToToolResultBlockParam()`:

```typescript
// Tool returns:  { data: unknown, contextModifier?: fn }
// Mapped to:     ToolResultBlockParam { type: 'tool_result', tool_use_id, content, is_error? }
// Wrapped in:    UserMessage with content: [toolResultBlock, ...optionalFeedback]
```

The result block is then size-checked against the per-tool budget and the aggregate per-message budget. Oversized results are written to a session-specific directory on disk and replaced with:

```
Output too large (123.4 KB). Full output saved to: /session/tool-results/abc.json

Preview (first 2 KB):
[first 2000 bytes]
```

The agent loop collects these user messages and feeds them back to the model in the next API call alongside the assistant messages that contained the tool_use blocks.

### What We Borrow vs Skip

| Claudy pattern | Borrow? | Rationale |
|---|---|---|
| Single execution path (`toolExecution.ts`) | **Yes** | Core principle: one path, every tool, every time |
| Zod input validation | **Yes** | Type-safe inputs, catch errors before execution |
| Concurrency batching (`toolOrchestration.ts`) | **Yes** | Latency win for multiple read-only calls |
| Per-tool + aggregate result budgeting | **Yes** | Prevent context window bloat |
| Abort signal hierarchy | **Yes** | Already partially implemented; formalize it |
| Async generator yield pattern | **Yes** | Clean boundary between loop and tool execution |
| Error classification | **Yes, simplified** | Tag errors for logging without leaking user data |
| Hook middleware (pre/post hooks) | **No** | DigitalMe is headless; policy is config-driven, not per-call |
| Permission dialogs and rule layering | **No** | No interactive user; creator config controls enablement |
| Streaming tool executor | **No** | DigitalMe waits for full model step (correct for SSE response model) |
| Tool search / deferred loading | **No** | Premature with <10 tools |
| UI rendering methods | **No** | API-only agent |
| Context modifiers from tools | **Deferred** | No tools currently mutate shared state; add when needed |
| Progress callbacks | **Deferred** | Worth adding when tools are long-running (>5s) |

## Claudy Patterns Worth Borrowing — Detail

The sections below drill into the specific patterns we're adapting for DigitalMe.

### 1. Tool Definition Metadata

In claudy, the `Tool` type carries ~40 fields. Most are UI/permission concerns that don't apply here. The fields worth borrowing:

| Claudy field | Purpose | DigitalMe adaptation |
|---|---|---|
| `inputSchema` (Zod) | Runtime input validation | Use Zod schemas per tool; parse before execution |
| `validateInput(input, context)` | Semantic validation beyond schema | Optional hook for business-rule checks (e.g., query length limits) |
| `isConcurrencySafe(input)` | Input-dependent concurrency classification | Start with a static boolean, upgrade to per-input later |
| `isReadOnly(input)` | Marks tools that don't mutate state | Drives concurrency batching |
| `maxResultSizeChars` | Per-tool inline result budget | Hard cap before truncation or externalization |
| `mapToolResultToToolResultBlockParam()` | Normalize result for model consumption | Map `ToolExecutionResult` into a bounded message payload |
| `getToolUseSummary(input)` | Short human-readable action description | For logging and future prompt-summary projection |
| `timeoutMs` | Per-tool timeout | Override the current global 5s constant |
| `policyCategory` | Group tools by risk/cost | Feed into per-category rate limits and moderation policy |

**Key insight from claudy:** some tool properties depend on the specific input, not only the tool type. `isConcurrencySafe(input)` is the canonical example — a tool might be safe for reads but not writes. DigitalMe should model this from the start even if the first tools only return static values.

### 2. Centralized Execution Path

In claudy, `toolExecution.ts` (~1,750 lines) is the single entry point for all tool execution. Every tool goes through:

```
lookup → parse input (Zod) → validateInput → pre-hooks → policy/permission → execute(timeout, abort) → post-hooks → normalize result → persist if large → emit analytics
```

DigitalMe does not need hooks or a permission dialog, but it does need the principle: **one path, every tool, every time**. The current `TurnExecutor.executeTool()` is too thin to be that path.

### 3. Concurrency Orchestration

Claudy's `toolOrchestration.ts` partitions tool calls into batches:

```
[read-only, read-only] → run concurrently
[write]                → run alone
[read-only]            → run concurrently
```

The algorithm is simple: scan the tool call list, group consecutive concurrency-safe calls, execute each group as a batch. Non-safe calls form single-item batches.

For digitalme-agent, the model may request multiple tool calls in one step (the LLM returns `tool_calls: [...]`). Today these are executed sequentially in `TurnExecutor` lines 89-114. Once more tools exist (e.g., web search + memory lookup), concurrent execution of read-only calls is a straightforward latency win.

### 4. Result Budgeting and Externalization

Claudy's `toolResultStorage.ts` implements a two-tier budget:

- **Per-tool threshold:** `maxResultSizeChars` (default 50K chars). Results larger than this are persisted to disk and replaced with a 2KB preview.
- **Aggregate budget:** Total tool result content per message is capped. Results that push past the aggregate limit are also externalized.

The externalized result message looks like:

```
Output too large (123.4 KB). Full output saved to: /path/to/file.json

Preview (first 2 KB):
[truncated content]
```

For digitalme-agent, externalization to disk doesn't make sense (the agent is ephemeral, no local filesystem for the fan to access). Instead:

- **Truncation with summary:** cut to budget, append `[truncated — N chars omitted]`.
- **Aggregate tracking:** `ToolExecutor` tracks cumulative result size across the turn and applies progressively tighter truncation as budget is consumed.

### 5. Abort Signal Hierarchy

Claudy uses a three-level abort signal chain:

```
request abort controller (user cancels)
  └─ sibling abort controller (Bash error cascades to other tools)
       └─ per-tool abort controller (individual tool timeout/cancellation)
```

DigitalMe already propagates the request signal. The addition needed is a per-tool timeout controller that composes with the request signal:

```typescript
const toolController = new AbortController();
const timeout = setTimeout(() => toolController.abort(), tool.timeoutMs);
signal?.addEventListener('abort', () => toolController.abort(), { once: true });
```

This is essentially what `WebSearchTool` already does internally. The executor should own this pattern so individual tools don't have to.

### 6. Error Classification

Claudy classifies tool errors into telemetry-safe categories (strips file paths and sensitive content). DigitalMe should adopt a simpler version: tag errors as `validation_error`, `timeout`, `execution_error`, or `aborted` so that logging and monitoring can aggregate without leaking user data.

## Target Design

### New Files

| File | Responsibility |
|---|---|
| `src/tools/execution/ToolExecutor.ts` | Single entry point for tool execution. Owns validation, policy check, timeout, result rendering, normalization, and budget enforcement. |
| `src/tools/execution/ToolPolicyChecker.ts` | `IToolPolicyChecker` interface and default pass-through implementation. Evaluates `policyCategory` against creator config and runtime state. |
| `src/tools/execution/ResultBudget.ts` | Tracks cumulative result size within a turn. Post-execution normalization for concurrent batches. |
| `src/tools/execution/types.ts` | `ToolExecutionMetadata`, `NormalizedToolResult`, `ToolPolicyDecision`, error classification enums. |

### Changed Files

| File | Change |
|---|---|
| `src/tools/types.ts` | Extend `Tool` interface with metadata fields. Add `ToolInputSchema` type. |
| `src/tools/registry.ts` | Accept dynamic registration. Remove hardcoded constructor logic. |
| `src/tools/web-search.ts` | Conform to extended `Tool` interface (add schema, timeout, budget, etc.). |
| `src/agent/TurnExecutor.ts` | Replace inline dispatch with `ToolExecutor.runTools()`. Support concurrent batching. |

### Not Planned

These claudy features are explicitly out of scope (see the "What We Borrow vs Skip" table in the architecture reference for full rationale):

- **Hook system (pre/post tool hooks):** DigitalMe is headless and server-side. Policy evaluation is handled by `IToolPolicyChecker`, not a general-purpose hook/middleware system.
- **Permission/approval dialogs:** Creator config controls what's enabled at registration time, not at call time.
- **Streaming tool executor:** DigitalMe waits for the full model step, which is correct for its SSE-based response model.
- **Tool search / deferred loading:** Premature with <10 tools.
- **UI rendering methods:** API-only agent.
- **Context modifiers:** No tools currently mutate shared state. Add the plumbing when a tool needs it.

## Proposed Interfaces

### Extended Tool Interface

```typescript
import { z } from 'zod';

// Tools receive a narrow policy-relevant config subset, not the full
// AgentConfig. Policy-sensitive decisions (rate limits, moderation
// thresholds, feature flags) stay executor-owned. Tools only see what
// they need to do their job.
export interface ToolPolicyConfig {
  allowedDomains?: string[];       // e.g., restrict web search to certain domains
  maxQueryLength?: number;         // input size limits
  // Extend as needed — but keep it minimal. If a tool needs something
  // from full config, ask whether it belongs here or in the policy stage.
}

export interface ToolContext {
  conversationId: string;
  signal: AbortSignal;             // always provided (executor guarantees)
  policyConfig: ToolPolicyConfig;  // narrow config subset for tools
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;   // JSON Schema for model
  };
}

// Tools return structured output, not just strings. This separates raw
// tool data from model-facing rendering. The executor calls
// renderForModel() to produce the string that goes into prompt history.
// This allows tools to return rich structured data (search results with
// URLs, memory lookups with metadata) while keeping the model-facing
// representation bounded and controlled.
export interface ToolExecutionResult<TData = unknown> {
  success: boolean;
  data: TData;                     // structured output (tool-defined shape)
  renderForModel(): string;        // model-facing string representation
}

export interface ToolMetadata {
  timeoutMs: number;                       // per-tool timeout (default: 10_000)
  maxResultChars: number;                  // inline result budget (default: 20_000)
  policyCategory: 'search' | 'memory' | 'action';
}

export const DEFAULT_TOOL_METADATA: ToolMetadata = {
  timeoutMs: 10_000,
  maxResultChars: 20_000,
  policyCategory: 'search',
};

// Tool uses default generic params for type erasure. The registry and
// executor store tools as Tool (no params), which resolves to
// Tool<Record<string, unknown>>. Each concrete tool implements
// Tool<SpecificInput> for internal type safety, but the default params
// let it be stored without a separate non-generic interface.
// The executor always calls inputSchema.parse() first and passes the
// parsed result through to execute(), so runtime type safety is
// guaranteed regardless of the erased compile-time type.
export interface Tool<TInput = Record<string, unknown>> {
  readonly name: string;
  readonly definition: ToolDefinition;
  readonly metadata: ToolMetadata;
  readonly inputSchema: z.ZodType<TInput>;

  execute(args: TInput, context: ToolContext): Promise<ToolExecutionResult>;

  // Input-dependent concurrency classification. Called with parsed input
  // BEFORE batching decisions. Defaults to false (serial) when not defined.
  // This follows claudy's pattern where concurrency safety depends on the
  // specific input, not just the tool type — e.g., a tool might be safe
  // for reads but not writes.
  isConcurrencySafe?(args: TInput): boolean;

  // Optional overrides (executor provides defaults)
  validateInput?(args: TInput, context: ToolContext): string | null;
  summarizeResult?(args: TInput, result: ToolExecutionResult): string;
}
```

### ToolExecutor Types

```typescript
export type ToolErrorCategory =
  | 'validation_error'
  | 'policy_rejected'
  | 'timeout'
  | 'execution_error'
  | 'aborted'
  | 'unknown_tool';

export interface NormalizedToolResult {
  success: boolean;
  content: string;                  // possibly truncated
  truncated: boolean;
  originalChars: number;
  errorCategory?: ToolErrorCategory;
}

export interface ToolExecutionRecord {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: NormalizedToolResult;
  modelContent: string;             // rendered + truncated string for model prompt
  durationMs: number;
  summary: string;                  // short description for logging (NOT model-facing)
}
```

### ResultBudget

Budget enforcement uses **post-execution normalization**, following claudy's
approach. Concurrent tools run freely against their per-tool
`maxResultChars` limit. After all tools in a batch complete, the budget
pass scans results and truncates the largest ones until the aggregate
fits. This is better than pre-reservation because it keeps the most
useful data — a tool that returns 500 chars shouldn't waste a 4,000-char
reservation.

```typescript
export class ResultBudget {
  private consumed = 0;

  constructor(private readonly maxTotalChars: number = 80_000) {}

  /**
   * Apply per-tool truncation to the model-facing string (serial path).
   * This operates on modelContent — the rendered string that goes into
   * prompt history — NOT on the structured result.data.
   */
  truncateAndConsume(modelContent: string, perToolMax: number): {
    content: string;
    truncated: boolean;
    originalChars: number;
  } {
    const limit = Math.min(perToolMax, this.remaining);
    const result = truncateResult(modelContent, limit);
    this.consumed += result.content.length;
    return result;
  }

  /**
   * Apply aggregate budget to a batch of model-facing strings (concurrent path).
   * Called AFTER all tools in a concurrent batch complete.
   * Per-tool maxResultChars are already applied to each record's modelContent.
   * This pass enforces the aggregate cap by truncating the largest
   * modelContent strings first.
   */
  normalizeBatch(records: ToolExecutionRecord[]): void {
    // 1. Sum all model-facing content sizes
    let total = records.reduce((sum, r) => sum + r.modelContent.length, 0);

    // 2. While over budget, truncate the largest model content
    while (total + this.consumed > this.maxTotalChars && records.length > 0) {
      const largest = records.reduce((max, r) =>
        r.modelContent.length > max.modelContent.length ? r : max
      );
      const allowed = Math.max(0,
        largest.modelContent.length - (total + this.consumed - this.maxTotalChars)
      );
      const truncated = truncateResult(largest.modelContent, allowed);
      total -= largest.modelContent.length - truncated.content.length;
      largest.modelContent = truncated.content;
      largest.result = {
        ...largest.result,
        truncated: true,
      };
    }

    this.consumed += total;
  }

  get remaining(): number {
    return Math.max(0, this.maxTotalChars - this.consumed);
  }
}
```

## ToolExecutor API

```typescript
export interface ToolExecutorCallbacks {
  // Events fire in real time: under concurrency, tool_start/tool_end
  // events arrive in completion order (reflecting actual execution).
  // The returned ToolExecutionRecord[] array is always in the model's
  // original call order. Monitoring should use records for ordered
  // analysis, not the real-time event stream.
  onToolStart: (name: string, callId: string) => void;
  onToolEnd: (name: string, callId: string, success: boolean) => void;
}

export class ToolExecutor {
  constructor(private readonly registry: IToolRegistry) {}

  async runTools(
    calls: ToolCall[],
    context: ToolContext,
    budget: ResultBudget,
    callbacks: ToolExecutorCallbacks,
  ): Promise<ToolExecutionRecord[]> {
    // Parse inputs and check concurrency safety BEFORE batching.
    // This follows claudy's pattern: input must be parsed before
    // isConcurrencySafe(input) can be evaluated. If parse fails,
    // default to unsafe (serial).
    const parsed = calls.map(call => {
      const tool = this.registry.get(call.function.name);
      if (!tool) return { call, tool: undefined, parsedInput: undefined, safe: false };
      const parseResult = tool.inputSchema.safeParse(
        JSON.parse(call.function.arguments || '{}'),
      );
      const safe = parseResult.success
        ? (tool.isConcurrencySafe?.(parseResult.data) ?? false)
        : false;
      return { call, tool, parsedInput: parseResult, safe };
    });

    const batches = partitionIntoBatches(parsed);
    const records: ToolExecutionRecord[] = [];

    for (const batch of batches) {
      if (batch.concurrent) {
        // Run concurrently, apply per-tool maxResultChars only.
        // Post-execution: normalizeBatch enforces aggregate budget.
        const batchRecords = await Promise.allSettled(
          batch.items.map(item =>
            this.runSingleTool(item, context, callbacks),
          ),
        );
        const resolved = resolveSettledRecords(batch.items, batchRecords);
        budget.normalizeBatch(resolved);
        records.push(...resolved);
      } else {
        for (const item of batch.items) {
          const record = await this.runSingleTool(item, context, callbacks);
          // Serial path: truncate modelContent against per-tool limit and aggregate.
          const truncated = budget.truncateAndConsume(
            record.modelContent,
            item.tool?.metadata.maxResultChars ?? DEFAULT_TOOL_METADATA.maxResultChars,
          );
          record.modelContent = truncated.content;
          if (truncated.truncated) {
            record.result = { ...record.result, truncated: true };
          }
          records.push(record);
        }
      }
    }

    return records;
  }

  private async runSingleTool(
    item: ParsedToolCall,
    context: ToolContext,
    callbacks: ToolExecutorCallbacks,
  ): Promise<ToolExecutionRecord> {
    // Steps 1-6 of the execution flow below.
    // Calls tool.execute() → result.renderForModel() → sets modelContent.
    // Per-tool maxResultChars truncation is applied to modelContent here.
    // Aggregate budget is applied by the caller to modelContent
    // (serial: truncateAndConsume, concurrent: normalizeBatch).
    // The structured result.data is never truncated — only modelContent is.
  }
}
```

## Proposed Execution Flow

All tools execute through `ToolExecutor.runTools()`:

```
TurnExecutor receives tool_calls from model
  │
  ▼
ToolExecutor.runTools(calls, context, budget)
  │
  ├─ Phase 1: Parse, validate, and check policy (ALL SERIAL)
  │   for each call:
  │     1. Lookup tool in registry → unknown_tool error if missing
  │     2. Parse input with tool.inputSchema (Zod) → validation_error if fails
  │     3. Run tool.validateInput() if defined → validation_error if rejected
  │     4. Check policy (see Policy Evaluation below) → policy_rejected if denied
  │     5. Evaluate tool.isConcurrencySafe(parsedInput) → default false
  │   Policy-rejected calls get an immediate error record (never executed).
  │
  ├─ Phase 2: Partition passing calls into batches
  │   [safe, safe] → concurrent batch
  │   [unsafe]     → serial batch
  │
  ▼ Phase 3: Execute batches in order
  │
  ├─ for each call in batch (parallel if concurrent, sequential otherwise):
  │   │
  │   ├─ 1. Create per-tool AbortController
  │   │      → compose request signal + tool timeout
  │   │
  │   ├─ 2. Execute tool.execute(parsedInput, context)
  │   │      → catch timeout → timeout error
  │   │      → catch abort  → aborted error
  │   │      → catch other  → execution_error
  │   │
  │   ├─ 3. Render result for model via result.renderForModel()
  │   │      → apply per-tool maxResultChars truncation to rendered string
  │   │
  │   └─ 4. Generate summary
  │        → tool.summarizeResult() if defined
  │        → else: "${toolName}(${key args}) → ${success ? 'ok' : 'failed'}"
  │        → summaries are for logging/monitoring, NOT model-facing
  │
  ├─ Phase 4: Apply aggregate budget
  │   serial batch:     budget.truncateAndConsume() per result
  │   concurrent batch: budget.normalizeBatch() after all results return
  │                     (truncates largest results first until under cap)
  │
  └─ Return ToolExecutionRecord[] in call order
```

### Policy Evaluation

The execution pipeline includes an explicit policy stage between
validation and execution. This is where `policyCategory` gets evaluated
against creator config and runtime state (rate limits, moderation flags).

```typescript
export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: string;    // human-readable rejection reason for logging
}

export interface IToolPolicyChecker {
  checkPolicy(
    toolName: string,
    policyCategory: ToolMetadata['policyCategory'],
    args: Record<string, unknown>,
    context: ToolContext,
  ): ToolPolicyDecision;
}
```

The `ToolExecutor` holds an `IToolPolicyChecker` instance (injected via
constructor). The first implementation is a pass-through that always
allows — but the boundary exists so rate limiting, moderation, and
creator restrictions can be added without changing the executor or tool
interfaces.

Policy state (rate limit counters, moderation flags) is **executor-owned**,
not tool-owned. Tools do not see or mutate policy state. This is the
answer to where shared mutable runtime state lives: the policy checker
owns it, and the executor is the only caller.

**Invariant:** Policy checks run in Phase 1, which is fully serial.
A policy-rejected call gets an immediate error record and is excluded
from batching and execution. Concurrent execution (Phase 3) never
touches policy state. This means the policy checker does not need to
be thread-safe or handle concurrent access.

```typescript
export class ToolExecutor {
  constructor(
    private readonly registry: IToolRegistry,
    private readonly policyChecker: IToolPolicyChecker,
  ) {}
  // ...
}
```

### Concurrency Batching Detail

Input is parsed and concurrency safety is evaluated **before** batching,
following claudy's pattern. This ensures `isConcurrencySafe(input)` sees
the actual parsed input, not just the tool type. If parsing fails, the
call defaults to unsafe (serial).

```typescript
interface ParsedToolCall {
  call: ToolCall;
  tool: Tool | undefined;
  parsedInput: z.SafeParseReturnType<unknown, unknown> | undefined;
  safe: boolean;
}

interface Batch {
  concurrent: boolean;
  items: ParsedToolCall[];
}

function partitionIntoBatches(parsed: ParsedToolCall[]): Batch[] {
  const batches: Batch[] = [];

  for (const item of parsed) {
    const last = batches[batches.length - 1];
    if (last && last.concurrent && item.safe) {
      last.items.push(item);     // extend current concurrent batch
    } else {
      batches.push({ concurrent: item.safe, items: [item] });
    }
  }

  return batches;
}
```

Concurrent batches use `Promise.allSettled()` for partial results. Serial batches execute one at a time. A sensible concurrency cap (e.g., 5) prevents runaway parallelism.

### Abort Signal Composition

```typescript
function createToolAbortSignal(
  requestSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  const onRequestAbort = () => controller.abort('request_aborted');
  requestSignal?.addEventListener('abort', onRequestAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      requestSignal?.removeEventListener('abort', onRequestAbort);
    },
  };
}
```

This lifts the pattern currently buried inside `WebSearchTool` (lines 60-64) into shared infrastructure.

### Result Truncation

The truncation function reserves space for the suffix marker so the
returned string never exceeds `maxChars`. If the budget is too small
even for the suffix, a fixed minimal placeholder is returned.

```typescript
const TRUNCATION_SUFFIX_BUDGET = 60;  // enough for "\n[truncated — 999999 chars omitted]"
const MINIMAL_PLACEHOLDER = '[result truncated]';

function truncateResult(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean; originalChars: number } {
  if (content.length <= maxChars) {
    return { content, truncated: false, originalChars: content.length };
  }

  // If budget is too small for content + suffix, return minimal placeholder
  if (maxChars <= TRUNCATION_SUFFIX_BUDGET) {
    return {
      content: MINIMAL_PLACEHOLDER.slice(0, maxChars),
      truncated: true,
      originalChars: content.length,
    };
  }

  // Reserve space for the suffix, then cut at a newline boundary
  const contentBudget = maxChars - TRUNCATION_SUFFIX_BUDGET;
  const cut = content.lastIndexOf('\n', contentBudget);
  const breakpoint = cut > contentBudget * 0.5 ? cut : contentBudget;
  const suffix = `\n[truncated — ${content.length - breakpoint} chars omitted]`;

  return {
    content: content.slice(0, breakpoint) + suffix,
    truncated: true,
    originalChars: content.length,
  };
}
```

## TurnExecutor Integration

After extraction, `TurnExecutor.run()` tool dispatch (currently lines 83-114) becomes:

```typescript
// Before: inline dispatch
for (const call of result.calls) {
  this.throwIfAborted(context.signal);
  toolCallCount += 1;
  activeTurn?.turnState.registerToolCall(call.id);
  const tool = this.toolRegistry.get(call.function.name);
  if (!tool) throw new Error(`Unknown tool: ${call.function.name}`);
  events.push({ type: 'tool_start', name: call.function.name, callId: call.id });
  const toolResult = await this.executeTool(call, context.conversationId, context.signal, tool);
  events.push({ type: 'tool_end', name: call.function.name, callId: call.id, success: toolResult.success });
  activeTurn?.turnState.resolveToolCall(call.id);
  context.messages.push({ role: 'tool', content: toolResult.content, toolCallId: call.id, toolName: call.function.name });
}

// After: delegated to ToolExecutor
// ResultBudget is created per run() call — NOT an instance field.
// Each request gets a fresh budget so turns don't under-budget each other.
const records = await this.toolExecutor.runTools(result.calls, {
  conversationId: context.conversationId,
  signal: context.signal,
  policyConfig: this.config.toolPolicy ?? {},
}, resultBudget, {
  onToolStart: (name, callId) => {
    activeTurn?.turnState.registerToolCall(callId);
    events.push({ type: 'tool_start', name, callId });
  },
  onToolEnd: (name, callId, success) => {
    activeTurn?.turnState.resolveToolCall(callId);
    events.push({ type: 'tool_end', name, callId, success });
  },
});

toolCallCount += records.length;
for (const record of records) {
  context.messages.push({
    role: 'tool',
    content: record.modelContent,   // already rendered and truncated by executor
    toolCallId: record.callId,
    toolName: record.toolName,
  });
}
```

`TurnExecutor.executeTool()` private method is deleted. `ResultBudget` is a **local variable** created at the top of `run()`:

```typescript
async run(submission, events, activeTurn?) {
  const resultBudget = new ResultBudget();  // fresh per request
  // ...
}
```

It is scoped to a single request and discarded when `run()` returns. This prevents budget state from leaking across turns in the same session.

## WebSearchTool Migration

The existing `WebSearchTool` adapts to the new interface:

```typescript
export class WebSearchTool implements Tool<WebSearchInput> {
  readonly name = 'web_search';

  readonly metadata: ToolMetadata = {
    timeoutMs: 5_000,
    maxResultChars: 4_000,
    policyCategory: 'search',
  };

  // Read-only, no side effects — always safe to run in parallel
  isConcurrencySafe(_args: WebSearchInput): boolean { return true; }

  readonly inputSchema = z.object({
    query: z.string().min(1).max(500),
  });

  readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: this.name,
      description: 'Look up factual public web snippets via DuckDuckGo Instant Answer.',
      parameters: zodToJsonSchema(this.inputSchema),    // derive JSON Schema from Zod
    },
  };

  // execute() no longer needs internal timeout/abort logic — executor handles it.
  // Returns structured data; renderForModel() produces the model-facing string.
  async execute(args: WebSearchInput, context: ToolContext): Promise<ToolExecutionResult<WebSearchData>> {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', args.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('no_redirect', '1');
    url.searchParams.set('skip_disambig', '0');

    const response = await fetch(url, {
      signal: context.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return {
        success: false,
        data: { error: `HTTP ${response.status}` },
        renderForModel: () => `Search failed: HTTP ${response.status}.`,
      };
    }

    const data = await response.json();
    const results = parseSearchResults(data);  // extract heading, topics, URLs

    return {
      success: true,
      data: { query: args.query, results },     // structured: URLs, snippets, sources
      renderForModel: () => formatResultsAsText(results),  // plain text for model
    };
  }

  summarizeResult(args: WebSearchInput, result: ToolExecutionResult<WebSearchData>): string {
    return result.success
      ? `web_search("${args.query}") → ${result.data.results?.length ?? 0} results`
      : `web_search("${args.query}") → failed`;
  }
}
```

Key simplifications:
- `inputSchema` replaces manual `typeof args.query === 'string'` validation.
- `execute()` receives pre-validated `WebSearchInput`, not raw `Record<string, unknown>`.
- Timeout and abort signal composition moves to the executor.
- `definition.parameters` is derived from Zod schema (single source of truth).

## ToolRegistry Changes

```typescript
export class ToolRegistry implements IToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  // ... listDefinitions(), listNames(), get() unchanged ...
}

// Registration moves to a factory function or Agent setup:
export function createToolRegistry(config: AgentConfig): ToolRegistry {
  const registry = new ToolRegistry();
  if (config.persona.tools.allow_web_search) {
    registry.register(new WebSearchTool());
  }
  return registry;
}
```

`register()` becomes public. Construction and registration are separated so tests can inject tools without config gymnastics.

**Type erasure note:** The `Tool` interface uses **default generic parameters** (`Tool<TInput = Record<string, unknown>>`), following claudy's pattern. The registry and executor store tools as `Tool` (no type params), which resolves to `Tool<Record<string, unknown>>`:

```typescript
export interface IToolRegistry {
  listDefinitions(): ToolDefinition[];
  listNames(): string[];
  get(name: string): Tool | undefined;   // Tool with default params
}
```

Each concrete tool implements `Tool<SpecificInput>` (e.g., `Tool<WebSearchInput>`) for internal type safety. The executor always calls `inputSchema.parse()` first and casts the result when calling `execute()`:

```typescript
// Inside ToolExecutor.runSingleTool():
const parsed = tool.inputSchema.parse(rawArgs);  // runtime validation
const result = await tool.execute(parsed as Record<string, unknown>, context);
```

The generic parameter is a development-time convenience for tool authors — it ensures `execute()` and `isConcurrencySafe()` receive typed input inside the tool class. The registry doesn't care about the specific input type.

## Implementation Sequence

### Step 1: Extract ToolExecutor with policy boundary (serial only)

**Files:**
- New: `src/tools/execution/ToolExecutor.ts`, `src/tools/execution/ToolPolicyChecker.ts`, `src/tools/execution/types.ts`
- Change: `src/agent/TurnExecutor.ts`

**Work:**
- Create `ToolExecutor` with `runTools()` that processes calls sequentially.
- Create `IToolPolicyChecker` interface and `DefaultToolPolicyChecker` (pass-through).
- `ToolExecutor` constructor takes `IToolRegistry` and `IToolPolicyChecker`.
- Move JSON parsing, tool lookup, policy check, timeout, and abort signal composition into `ToolExecutor`.
- `TurnExecutor` delegates to `ToolExecutor.runTools()` via callbacks.
- Delete `TurnExecutor.executeTool()`.

**Exit criteria:**
- No tool is dispatched directly from `TurnExecutor`.
- Policy check boundary exists (even if first implementation always allows).
- All existing tests pass with no behavior change.

### Step 2: Richer Tool Interface and Result Model

**Files:**
- Change: `src/tools/types.ts`, `src/tools/registry.ts`, `src/tools/web-search.ts`

**Work:**
- Add `ToolMetadata`, `inputSchema`, `isConcurrencySafe()`, optional `validateInput`, optional `summarizeResult` to `Tool`.
- Change `ToolExecutionResult` to carry structured `data` + `renderForModel()`.
- Provide `DEFAULT_TOOL_METADATA` so existing tools can adopt incrementally.
- Add Zod dependency. Derive `definition.parameters` from Zod schema.
- Make `ToolRegistry.register()` public. Extract `createToolRegistry()`.
- Migrate `WebSearchTool` to the new interface (structured results, `isConcurrencySafe()`).
- `ToolExecutor` validates input via Zod before calling `execute()`.
- `ToolExecutor` calls `result.renderForModel()` to produce the model-facing string.

**Why Step 2 must include the full execution contract:** Step 3 (budgeting) truncates the rendered string, and Step 4 (concurrency) depends on `isConcurrencySafe()` and post-execution budget normalization. If Step 2 lands with a string-only result model or static concurrency flags, Steps 3-4 force a redesign of the Tool interface rather than extending it.

**Exit criteria:**
- `WebSearchTool` has a Zod schema, typed `execute()` signature, and structured result with `renderForModel()`.
- `isConcurrencySafe()` is a method on the Tool interface.
- Invalid input is caught by the executor, not the tool.

### Step 3: Result Budgeting

**Files:**
- New: `src/tools/execution/ResultBudget.ts`
- Change: `src/tools/execution/ToolExecutor.ts`, `src/agent/TurnExecutor.ts`

**Work:**
- Implement `ResultBudget` with two paths: `truncateAndConsume()` for serial, `normalizeBatch()` for concurrent.
- Serial path: truncate rendered string against `min(tool.metadata.maxResultChars, budget.remaining)`.
- Concurrent path: each tool truncates against its own `maxResultChars` during execution; `normalizeBatch()` enforces aggregate cap after the batch completes by truncating largest results first.
- `TurnExecutor` creates a `ResultBudget` as a local variable per `run()` call.
- `NormalizedToolResult` carries `truncated` and `originalChars` fields.
- Truncation reserves space for the suffix marker (never exceeds budget).

**Exit criteria:**
- A tool returning >20K chars has its rendered model content truncated.
- Cumulative tool output in a single turn is bounded.
- Budget enforcement is deterministic under both serial and concurrent execution.

### Step 4: Concurrent Batching

**Files:**
- Change: `src/tools/execution/ToolExecutor.ts`

**Work:**
- Implement `partitionIntoBatches()`.
- Concurrent batches use `Promise.allSettled()` with a concurrency cap.
- Events (`tool_start`, `tool_end`) fire in real-time completion order under concurrency (not buffered to call order). This reflects actual execution timing for monitoring.
- The returned `ToolExecutionRecord[]` array is always in the model's original call order regardless of completion order. Downstream code should use records for ordered analysis.

**Exit criteria:**
- Two concurrent-safe tool calls in one model step execute in parallel.
- A non-safe tool call always executes alone.
- Ordering of tool result messages matches call order.

### Step 5: Tool-Use Summaries (optional, depends on prompt work)

**Files:**
- Change: `src/tools/execution/ToolExecutor.ts`, `src/agent/SessionState.ts`

**Work:**
- `ToolExecutionRecord.summary` is populated for every call.
- Store summaries alongside prompt history in `SessionState`.
- Future prompt projection can use summaries instead of raw tool output for older turns.

**Exit criteria:**
- Every tool execution produces a summary string.
- Summaries are accessible from `SessionState` for prompt construction.

## Testing Strategy

### Unit Tests

| What | How |
|---|---|
| Zod schema validation | Pass invalid inputs, verify `validation_error` result |
| `validateInput` rejection | Tool-specific semantic check returns error string |
| Timeout enforcement | Mock a tool that never resolves, verify timeout error after `timeoutMs` |
| Abort propagation | Abort request signal mid-execution, verify tool receives abort |
| Result truncation | Return >maxResultChars, verify truncation and `[truncated]` marker |
| Aggregate budget | Run multiple tools, verify later tools get tighter budget |
| Concurrency batching | Verify `partitionIntoBatches` groups safe calls, isolates unsafe |
| Error classification | Verify each failure mode maps to correct `ToolErrorCategory` |
| Summary generation | Verify default and custom `summarizeResult` output |

### Integration Tests

| What | How |
|---|---|
| Full turn with tool call | Model returns `tool_calls`, executor runs tool, result fed back, model produces final text |
| Concurrent execution | Two safe tools, verify wall-clock time < sum of individual durations |
| Budget across multi-turn | Run 3+ tool calls in one turn, verify cumulative truncation |

## Risks

| Risk | Mitigation |
|---|---|
| Over-engineering before enough tools exist | Steps are incremental. Stop after Step 2 if no new tools are imminent. |
| Zod dependency adds weight | Zod is ~50KB minified. Acceptable for input validation. Already common in TS ecosystems. |
| Concurrency bugs | Step 4 is last and optional. Serial path is always the fallback. |
| Budget tuning | Start with generous defaults (20K per tool, 80K per turn). Tune based on actual model context window usage. |

## Dependencies

- `zod` — input schema definition and validation
- `zod-to-json-schema` (or equivalent) — derive OpenAI-compatible JSON Schema from Zod types

## Success Criteria

1. No tool is executed directly from `TurnExecutor` — all calls go through `ToolExecutor`.
2. Every tool has a Zod input schema; invalid input is caught before `execute()`.
3. Every tool call passes through `IToolPolicyChecker` before execution.
4. Tools return structured data; model-facing strings are produced by `renderForModel()` and controlled by the executor.
5. Tool results are bounded: per-tool and per-turn budgets enforced, deterministic under concurrency.
6. Concurrency safety is input-dependent (`isConcurrencySafe(args)`), evaluated after parsing.
7. Read-only tools can run concurrently when the model requests multiple calls.
8. Every tool execution produces a typed `ToolExecutionRecord` with duration, structured result, rendered model content, and summary.
